/*
 * typeahead.js
 * https://github.com/twitter/typeahead.js
 * Copyright 2013-2014 Twitter, Inc. and other contributors; Licensed MIT
 */

var Bloodhound = (function() {
  'use strict';

  var old, keys;

  old = window && window.Bloodhound;
  keys = { data: 'data', protocol: 'protocol', thumbprint: 'thumbprint' };

  // constructor
  // -----------

  function Bloodhound(o, initialize) {
    if (!o || (!o.local && !o.prefetch && !o.remote)) {
      $.error('one of local, prefetch, or remote is required');
    }

    this.sorter = getSorter(o.sorter);
    this.dupDetector = o.dupDetector || ignoreDuplicates;

    this.local = oParser.local(o);
    this.prefetch = oParser.prefetch(o);
    this.remote = oParser.remote(o);

    this.cacheKey = this.prefetch ?
      (this.prefetch.cacheKey || this.prefetch.url) : null;

    // the backing data structure used for fast pattern matching
    this.index = new SearchIndex({
      datumTokenizer: o.datumTokenizer,
      queryTokenizer: o.queryTokenizer
    });

    // only initialize storage if there's a cacheKey otherwise
    // loading from storage on subsequent page loads is impossible
    this.storage = this.cacheKey ? new PersistentStorage(this.cacheKey) : null;

    // if the initialize argument is truthy, kick off initialization
    o.initialize && this.initialize();
  }

  // static methods
  // --------------

  Bloodhound.noConflict = function noConflict() {
    window && (window.Bloodhound = old);
    return Bloodhound;
  };

  Bloodhound.tokenizers = tokenizers;

  // instance methods
  // ----------------

  _.mixin(Bloodhound.prototype, {

    // ### super secret stuff used for integration with jquery plugin

    __ttAdapter: function ttAdapter() {
      var that = this;

      return this.transport ? withAsync : withoutAsync;

      function withAsync(query, sync, async) {
        return that.get(query, sync, async);
      }

      function withoutAsync(query) {
        return that.get(query);
      }
    },

    // ### private

    _loadPrefetch: function loadPrefetch(o) {
      var that = this, serialized, deferred;

      if (serialized = this._readFromStorage(o.thumbprint)) {
        this.index.bootstrap(serialized);
        deferred = $.Deferred().resolve();
      }

      else {
        deferred = $.ajax(o.url, o.ajax).done(handlePrefetchResponse);
      }

      return deferred;

      function handlePrefetchResponse(resp) {
        // clear to mirror the behavior of bootstrapping
        that.clear();
        that.add(o.filter ? o.filter(resp) : resp);

        that._saveToStorage(that.index.serialize(), o.thumbprint, o.ttl);
      }
    },

    _getFromRemote: function getFromRemote(query, cb) {
      var that = this, url, uriEncodedQuery, ajax;

      if (!this.transport || !cb) { return; }

      query = query || '';
      uriEncodedQuery = encodeURIComponent(query);
      ajax = _.clone(this.remote.ajax);

      if (this.remote.before) {
        ajax = this.remote.before(this.remote.url, query, ajax);
      }

      else if (this.remote.replace) {
        url = this.remote.replace(this.remote.url, query);
      }

      else {
        url = this.remote.url.replace(this.remote.wildcard, uriEncodedQuery);
      }

      ajax.url = url || ajax.url || this.remote.url;
      return this.transport.get(ajax, handleRemoteResponse);

      function handleRemoteResponse(err, resp) {
        err ? cb([]) : cb(that.remote.filter ? that.remote.filter(resp) : resp);
      }
    },

    _cancelLastRemoteRequest: function cancelLastRemoteRequest() {
      // #149: prevents outdated rate-limited requests from being sent
      this.transport && this.transport.cancel();
    },

    _saveToStorage: function saveToStorage(data, thumbprint, ttl) {
      if (this.storage) {
        this.storage.set(keys.data, data, ttl);
        this.storage.set(keys.protocol, location.protocol, ttl);
        this.storage.set(keys.thumbprint, thumbprint, ttl);
      }
    },

    _readFromStorage: function readFromStorage(thumbprint) {
      var stored = {}, isExpired;

      if (this.storage) {
        stored.data = this.storage.get(keys.data);
        stored.protocol = this.storage.get(keys.protocol);
        stored.thumbprint = this.storage.get(keys.thumbprint);
      }

      // the stored data is considered expired if the thumbprints
      // don't match or if the protocol it was originally stored under
      // has changed
      isExpired = stored.thumbprint !== thumbprint ||
        stored.protocol !== location.protocol;

      return stored.data && !isExpired ? stored.data : null;
    },

    _initialize: function initialize() {
      var that = this, local = this.local, deferred;

      // in case this is a reinitialization, clear previous data
      this.clear();

      deferred = this.prefetch ?
        this._loadPrefetch(this.prefetch) : $.Deferred().resolve();

      // make sure local is added to the index after prefetch
      local && deferred.done(addLocalToIndex);

      this.transport = this.remote ? new Transport(this.remote) : null;

      return (this.initPromise = deferred.promise());

      function addLocalToIndex() {
        // local can be a function that returns an array of datums
        that.add(_.isFunction(local) ? local() : local);
      }
    },

    // ### public

    initialize: function initialize(force) {
      return !this.initPromise || force ? this._initialize() : this.initPromise;
    },

    add: function add(data) {
      this.index.add(data);
      return this;
    },

    get: function get(query, sync, async) {
      var that = this, local;

      local = this.sorter(this.index.get(query));

      // return a copy to guarantee no changes within this scope
      // as this array will get used when processing the remote results
      sync(this.remote ? local.slice() : local);

      if (this.remote && local.length < this.remote.sufficient) {
        this._getFromRemote(query, processRemote);
      }

      else if (this.remote) {
        this._cancelLastRemoteRequest();
      }

      return this;

      function processRemote(remote) {
        var nonDuplicates = [];

        _.each(remote, function(r) {
          var isDuplicate;

          // checks for duplicates
          isDuplicate = _.some(local, function(l) {
            return that.dupDetector(r, l);
          });

          !isDuplicate && nonDuplicates.push(r);
        });

        async && async(nonDuplicates);
      }
    },

    all: function all() {
      return this.index.all();
    },

    clear: function clear() {
      this.index.reset();
      return this;
    },

    clearPrefetchCache: function clearPrefetchCache() {
      this.storage && this.storage.clear();
      return this;
    },

    clearRemoteCache: function clearRemoteCache() {
      this.transport && Transport.resetCache();
      return this;
    },

    // DEPRECATED: will be removed in v1
    ttAdapter: function ttAdapter() {
      return this.__ttAdapter();
    }
  });

  return Bloodhound;

  // helper functions
  // ----------------

  function getSorter(sortFn) {
    return _.isFunction(sortFn) ? sort : noSort;

    function sort(array) { return array.sort(sortFn); }
    function noSort(array) { return array; }
  }

  function ignoreDuplicates() { return false; }
})(this);