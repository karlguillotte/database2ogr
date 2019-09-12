/*
 * @file everything to output database areas as json
 * @author jacob
 * @version 0.1
 */

/* represents a GeoJSON feature */
class Feature {
  /**
   * @param {JSON} geometry - GeoJSON geometry object
   * @param {string} feature_type  - the table the feature came from
   * @param {object} properties    - properties associated with feature. Every column pulled from the table that isn't geometry.
   */
  constructor(geometry, feature_type, properties) {
    this.type = "Feature";
    this.geometry = JSON.parse(geometry);
    //this.geometry = geometry;
    this.properties = properties;
    this.properties.type = feature_type;
  }
}

/* GeoJSON FeatureCollection */
class FeatureCollection {
  /**
   * @param {Array} features - list of the features collected
   */
  constructor(features) {
    this.type = "FeatureCollection";
    this.features = features;
  }
}

/* information needed for querying the database. */
class Query {
  /**
   * @param {string} table                - table to SELECT from
   * @param {Array}  non_geometry_columns - columns that don't contain geometry
   * @param {string} where_clause         - SQL WHERE clause, eg "WHERE area_id=$1"
   * @param {string} geometry_column      - column with the geometry
   * @param {Query}  subquery             - in practice, query to decision_point_warnings from inside decision_points
   */
  constructor(table, non_geometry_columns, where_clause, geometry_column='geom', subquery=null) {
    this.table = table;
    this.non_geometry_columns = non_geometry_columns;
    this.where_clause = where_clause;
    this.geometry_column = geometry_column;
    this.subquery = subquery;
  }

  /**
   * @returns a SQL valid select statement based for this object
   */
  to_query() {
    if(this.geometry_column == null) {
      return `SELECT ${this.non_geometry_columns.join(', ')} FROM ${this.table} WHERE ${this.where_clause};`;
    } else {
      return `SELECT ST_AsGeoJSON(${this.geometry_column}) AS geometry, ${this.non_geometry_columns.join(', ')} FROM ${this.table} WHERE ${this.where_clause};`;
    }
  }
}

/**
 * @param {Iterable} features - an iterable of feature objects. In practice, a Generator.
 * @returns {FeatureCollection} a new FeatureCollection object
 */
async function collect_features(features) {
  collected_features = [];
  for await (feature of features) {
    collected_features.push(feature);
  }
  return new FeatureCollection(Array.from(collected_features));
}

/**
 * @param {Iterable} rows - database rows
 * @yields {Feature} a Feature object
 */
async function* object_to_feature(rows) {
  //SELECT ST_GeoJSON(geom) AS geometry
  geometry_row = 'geometry';
  for await (row of rows) {
    geometry = row[geometry_row];
    feature_type = row['table'];
    delete row[geometry_row];
    delete row['table'];
    yield new Feature(
      geometry,
      feature_type,
      row
    );
  }
}

/**
 * get the warnings associated with a decision point
 * @param {Query} query             -
 * @param {int}   decision_point_id - 
 * @return {Array} all associated warnings
 */
async function get_warnings(query, decision_point_id) {
  let warnings = [];
  for await (const warning of get_from_database(query_object.subquery, row.id)) {
    warnings.append(warning);
  }
  return warnings;
}

/**
 * @function get_from_database
 * @description get rows from the database
 * @param {Array} queries - Array of Query objects
 * @param {int} area_id   - area_id we're getting data from
 * @param {Client} client - pg Client object used to query the database
 * @yield {row}             database row
 */
async function* get_from_database(queries, area_id, client) {
  for(let query_object of queries) {
    let query = {
      name: `get rows from ${query_object.table}`,
      text: query_object.to_query(),
      values: [area_id],
    };

    let rows = await client
      .query(query)
      .then(res => res.rows)
      .catch(e => console.error(e.stack))

    for (let row of rows) {
      row.table = query_object.table;
      if (row.table == 'decision_points') {
        warnings = get_warnings(query_object.subquery, row.id);
        row.warnings = warnings;
      }
      yield row;
    }
  } //endfor query of queries
}

/**
 * @function main
 * @description get a GeoJSON FeatureCollection with a Feature for each row of each table for which there is a query object in queries.
 * @param {int} area_id - the area you want features from
 */
async function main(area_id) {
  function connect_to_database(constring) {
    const {Pool, Client} = require('pg');

    return new Client({
      connectionString: constring,
    });
  }

  const CONSTRING = 'postgresql://postgres:ZkyKGQem@ates.c04cdk6ard61.us-west-2.rds.amazonaws.com/ates';

  const queries = [
    new Query(
      'points_of_interest',
      ['name', 'type'],
      'area_id=$1',
    ),
    new Query(
      'access_roads',
      ['description'],
      'area_id=$1',
    ),
    new Query(
      'avalanche_paths',
      ['name'],
      'area_id=$1',
    ),
    new Query(
      'decision_points',
      ['name', 'details', 'id'],
      'area_id=$1',
      geometry_row='geom',
      subquery=new Query(
        'decision_points_warnings',
        ['warning', 'type'],
        'decision_point_id=$1',
        geometry_row=null,
      ),
    ),
    new Query(
      'zones',
      ['class_code',],
      'area_id=$1',
    ),
  ];

  const client = connect_to_database(CONSTRING);

  client.connect();

  feature_collection = await collect_features(
    object_to_feature(
      get_from_database(queries, area_id, client)
    )
  );

  client.end();

  const geojson = JSON.stringify(feature_collection);

  //console.log(geojson);

  return geojson;
}

//main(357);