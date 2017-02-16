// Adapted from https://github.com/cnect/sails-sqlserver/blob/master/lib/sql.js

var _ = require('lodash');
var debug = require('debug')('sql-view');
var assert = require('assert');

var sql = {

  wrap: function(identifier) {
    if (sql.dialect === 'postgres') {
      return '"' + identifier + '"';
    } else {
      return '[' + identifier + ']';
    }
  },

  values: function(values, key) {
    return sql.buildWhere(values, sql.prepareValue, ', ', key);
  },

  prepareCriterion: function(value, key, parentKey) {
    if (_.isObject(value) && !_.isDate(value) && !_.isArray(value)) {
      return sql.where(value, null, key);
    }
    var attrStr;
    if (parentKey) {
      attrStr = sql.wrap(parentKey);
      if (key === 'lt') {
        return attrStr + '<' + sql.prepareValue(value);
      } else if (key === 'lte') {
        return attrStr + '<=' + sql.prepareValue(value);
      } else if (key === 'gt') {
        return attrStr + '>' + sql.prepareValue(value);
      } else if (key === 'gte') {
        return attrStr + '>=' + sql.prepareValue(value);
      } else if (key === 'not') {
        if (value === null) {
          return attrStr + ' IS NOT NULL';
        } else if (_.isArray(value)) {
          return attrStr + ' NOT IN (' + sql.values(value, key) + ')';
        } else {
          return attrStr + '<>' + sql.prepareValue(value);
        }
      } else if (key === 'like' || key === 'contains' || key === 'startsWith' || key === 'endsWith') {
        if (key === 'contains') {
          value = '%' + value + '%';
        } else if (key === 'startsWith') {
          value += '%';
        } else if (key === 'endsWith') {
          value = '%' + value;
        }
        return attrStr + ' LIKE ' + sql.prepareValue(value);
      } else {
        throw new Error('Unknown comparator: ' + key);
      }
    } else {
      attrStr = sql.wrap(key);
      if (_.isNull(value)) {
        return attrStr + ' IS NULL';
      } else {
        return attrStr + '=' + sql.prepareValue(value, key);
      }
    }
  },

  prepareValue: function(value) {
    sql.params.push(value);
    return '$' + sql.params.length;
  },

  where: function(where, key, parentKey) {
    return sql.buildWhere(where, sql.predicate, ' AND ', undefined, parentKey);
  },

  predicate: function(criterion, key, parentKey) {
    var partial = '';
    if (parentKey) {
      return sql.prepareCriterion(criterion, key, parentKey);
    }
    if (key.toLowerCase() === 'or') {
      partial = sql.buildWhere(criterion, sql.where, ' OR ');
      return ' ( ' + partial + ' ) ';
    } else if (key.toLowerCase() === 'and') {
      partial = sql.buildWhere(criterion, sql.where, ' AND ');
      return ' ( ' + partial + ' ) ';
    } else if (_.isArray(criterion)) {
      var values = sql.values(criterion, key) || 'NULL';
      partial = sql.wrap(key) + ' IN (' + values + ')';
      return partial;
    } else {
      return sql.prepareCriterion(criterion, key);
    }
  },

  buildWhere: function(collection, fn, separator, keyOverride, parentKey) {
    separator = separator || ', ';
    var where = '';
    _.each(collection, function(value, key) {
      where += fn(value, keyOverride || key, parentKey);
      where += separator;
    });
    return _.trim(where, separator);
  }

};

module.exports = function(dialect) {

  return {
    build: function(view, criteria) {
      criteria = criteria || {};
      sql.dialect = dialect || 'mssql';
      sql.params = [];
      var statement = build(view, criteria);
      debug(dialect, statement);
      return {
        statement: statement,
        params: sql.params
      };
    }
  };

};

function build(view, criteria) {

  var columns = [];
  var groupBy = [];
  var orderBy = [];
  var where = criteria.where ? sql.where(criteria.where) : void 0;

  _.forEach(toArray(criteria.select), function(column) {
    var info = splitAlias(column);
    columns.push(info.column + ' AS ' + info.as);
  });

  _.forEach(toArray(criteria.groupBy), function(column) {
    var info = splitAlias(column);
    columns.push(info.column + ' AS ' + info.as);
    groupBy.push(info.column);
  });

  _.forEach(toArray(criteria.sum), function(column) {
    var info = splitAlias(column);
    columns.push('SUM(' + info.column + ') AS ' + info.as);
  });

  _.forEach(toArray(criteria.avg), function(column) {
    var info = splitAlias(column);
    columns.push('AVG(' + info.column + ') AS ' + info.as);
  });

  _.forEach(toArray(criteria.max), function(column) {
    var info = splitAlias(column);
    columns.push('MAX(' + info.column + ') AS ' + info.as);
  });

  _.forEach(toArray(criteria.min), function(column) {
    var info = splitAlias(column);
    columns.push('MIN(' + info.column + ') AS ' + info.as);
  });

  _.forEach(toArray(criteria.count), function(column) {
    var info = splitAlias(column);
    columns.push('COUNT(' + info.column + ') AS ' + info.as);
  });

  _.forEach(toArray(criteria.order), function(column) {
    var direction;
    if (column.substr(column.length - 4).toUpperCase() === ' ASC') {
      direction = 'ASC';
      column = column.substr(0, column.length - 4);
    } else if (column.substr(column.length - 5).toUpperCase() === ' DESC') {
      direction = 'DESC';
      column = column.substr(0, column.length - 5);
    }
    orderBy.push(sql.wrap(column) + (direction ? ' ' + direction : ''));
  });

  var statement = 'SELECT ' +
    (columns.length ? columns.join() : '*') +
    ' FROM ' +
    (isView(view) ? '(' + view + ') t' : sql.wrap(view)) +
    (where ? ' WHERE ' + where : '') +
    (groupBy.length ? ' GROUP BY ' + groupBy.join() : '');

  if (sql.dialect === 'postgres') {
    if (orderBy.length) {
      statement += ' ORDER BY ' + orderBy.join();
    }
    if (criteria.limit) {
      statement += ' LIMIT ' + criteria.limit;
    }
    if (criteria.skip) {
      assert(criteria.order, 'Order should be defined when using skip');
      statement += ' OFFSET ' + criteria.skip;
    }
  } else { // msssql
    if (criteria.skip) {
      assert(criteria.order, 'Order should be defined when using skip');
      statement = 'SELECT' +
        (criteria.limit ? ' TOP ' + criteria.limit : '') +
        ' * FROM (SELECT ROW_NUMBER() OVER (ORDER BY ' + orderBy.join() +
        ') AS row_number,* FROM (' + statement + ') t) t ' +
        'WHERE row_number > ' + criteria.skip;
    } else {
      if (orderBy.length) {
        statement += ' ORDER BY ' + orderBy.join();
      }
      if (criteria.limit) {
        statement = statement.replace('SELECT ', 'SELECT TOP ' + criteria.limit + ' ');
      }
    }
  }
  return statement;
}

function splitAlias(name) {
  var res = {};
  var re = /^(.+) as (.+)$/i;
  var match = re.exec(name);
  if (match) {
    res.column = sql.wrap(match[1]);
    res.as = sql.wrap(match[2]);
  } else {
    res.column = sql.wrap(name);
    res.as = res.column;
  }
  return res;
}

function toArray(element) {
  return element ?
    _.isArray(element) ? element : [element] :
    void 0;
}

function isView(view) {
  return view.toLowerCase().indexOf('select') !== -1;
}
