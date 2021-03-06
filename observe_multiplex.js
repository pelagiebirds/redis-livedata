var Future = Npm.require('fibers/future');

ObserveHelpers = {};

//_CachingChangeObserver is an object which receives observeChanges callbacks
//and keeps a cache of the current cursor state up to date in self.docs. Users
//of this class should read the docs field but not modify it. You should pass
//the "applyChange" field as the callbacks to the underlying observeChanges
//call. Optionally, you can specify your own observeChanges callbacks which are
//invoked immediately before the docs field is updated; this object is made
//available as `this` to those callbacks.
ObserveHelpers._CachingChangeObserver = function (options) {
  var self = this;
  options = options || {};

  var orderedFromCallbacks = false;
  //options.callbacks &&
  //     LocalCollection._observeChangesCallbacksAreOrdered(options.callbacks);
  if (_.has(options, 'ordered')) {
    self.ordered = options.ordered;
    if (options.callbacks && options.ordered !== orderedFromCallbacks)
      throw Error("ordered option doesn't match callbacks");
  } else if (options.callbacks) {
    self.ordered = orderedFromCallbacks;
  } else {
    throw Error("must provide ordered or callbacks");
  }
  var callbacks = options.callbacks || {};

  if (self.ordered) {
    self.docs = new OrderedDict(LocalCollection._idStringify);
    self.applyChange = {
      addedBefore: function (id, fields, before) {
        var doc = EJSON.clone(fields);
        doc._id = id;
        callbacks.addedBefore && callbacks.addedBefore.call(
          self, id, fields, before);
          // This line triggers if we provide added with movedBefore.
          callbacks.added && callbacks.added.call(self, id, fields);
          // XXX could `before` be a falsy ID?  Technically
          // idStringify seems to allow for them -- though
          // OrderedDict won't call stringify on a falsy arg.
          self.docs.putBefore(id, doc, before || null);
      },
      movedBefore: function (id, before) {
        var doc = self.docs.get(id);
        callbacks.movedBefore && callbacks.movedBefore.call(self, id, before);
        self.docs.moveBefore(id, before || null);
      }
    };
  } else {
    //self.docs = new LocalCollection._IdMap;
    self.docs = new IdMap(EJSON.stringify, EJSON.parse);
    self.applyChange = {
      added: function (id, fields) {
        var doc = EJSON.clone(fields);
        callbacks.added && callbacks.added.call(self, id, fields);
        doc._id = id;
        self.docs.set(id,  doc);
      }
    };
  }

  // The methods in _IdMap and OrderedDict used by these callbacks are
  // identical.
  self.applyChange.changed = function (id, fields) {
    var doc = self.docs.get(id);
    if (!doc)
      throw new Error("Unknown id for changed: " + id);
    callbacks.changed && callbacks.changed.call(
      self, id, EJSON.clone(fields));
      _applyChanges(doc, fields);
  };
  self.applyChange.removed = function (id) {
    callbacks.removed && callbacks.removed.call(self, id);
    self.docs.remove(id);
  };
};

var _applyChanges = function (doc, changeFields) {
  _.each(changeFields, function (value, key) {
    if (value === undefined)
      delete doc[key];
    else
      doc[key] = value;
  });
};



ObserveMultiplexer = function (options) {
  var self = this;

//  if (!options || !_.has(options, 'ordered'))
//    throw Error("must specified ordered");

  Package.facts && Package.facts.Facts.incrementServerFact(
    "redis-livedata", "observe-multiplexers", 1);

  self._ordered = !!options.ordered;
  self._onStop = options.onStop || function () {};
  self._queue = new Meteor._SynchronousQueue();
  self._handles = {};
  self._readyFuture = new Future;
  self._cache = new ObserveHelpers._CachingChangeObserver({
    ordered: options.ordered});
  // Number of addHandleAndSendInitialAdds tasks scheduled but not yet
  // running. removeHandle uses this to know if it's time to call the onStop
  // callback.
  self._addHandleTasksScheduledButNotPerformed = 0;

  _.each(self.callbackNames(), function (callbackName) {
    self[callbackName] = function (/* ... */) {
      self._applyCallback(callbackName, _.toArray(arguments));
    };
  });
};

_.extend(ObserveMultiplexer.prototype, {
  addHandleAndSendInitialAdds: function (handle) {
    var self = this;

    // Check this before calling runTask (even though runTask does the same
    // check) so that we don't leak an ObserveMultiplexer on error by
    // incrementing _addHandleTasksScheduledButNotPerformed and never
    // decrementing it.
    if (!self._queue.safeToRunTask())
      throw new Error(
        "Can't call observeChanges from an observe callback on the same query");
    ++self._addHandleTasksScheduledButNotPerformed;

    Package.facts && Package.facts.Facts.incrementServerFact(
      "redis-livedata", "observe-handles", 1);

    self._queue.runTask(function () {
      self._handles[handle._id] = handle;
      // Send out whatever adds we have so far (whether or not we the
      // multiplexer is ready).
      self._sendAdds(handle);
      --self._addHandleTasksScheduledButNotPerformed;
    });
    // *outside* the task, since otherwise we'd deadlock
    self._readyFuture.wait();
  },

  // Remove an observe handle. If it was the last observe handle, call the
  // onStop callback; you cannot add any more observe handles after this.
  //
  // This is not synchronized with polls and handle additions: this means that
  // you can safely call it from within an observe callback, but it also means
  // that we have to be careful when we iterate over _handles.
  removeHandle: function (id) {
    var self = this;

    // This should not be possible: you can only call removeHandle by having
    // access to the ObserveHandle, which isn't returned to user code until the
    // multiplex is ready.
    if (!self._ready())
      throw new Error("Can't remove handles until the multiplex is ready");

    delete self._handles[id];

    Package.facts && Package.facts.Facts.incrementServerFact(
      "redis-livedata", "observe-handles", -1);

    if (_.isEmpty(self._handles) &&
        self._addHandleTasksScheduledButNotPerformed === 0) {
      self._stop();
    }
  },
  _stop: function () {
    var self = this;
    // It shouldn't be possible for us to stop when all our handles still
    // haven't been returned from observeChanges!
    if (!self._ready())
      throw Error("surprising _stop: not ready");

    // Call stop callback (which kills the underlying process which sends us
    // callbacks and removes us from the connection's dictionary).
    self._onStop();
    Package.facts && Package.facts.Facts.incrementServerFact(
      "redis-livedata", "observe-multiplexers", -1);

    // Cause future addHandleAndSendInitialAdds calls to throw (but the onStop
    // callback should make our connection forget about us).
    self._handles = null;
  },
  // Allows all addHandleAndSendInitialAdds calls to return, once all preceding
  // adds have been processed. Does not block.
  ready: function () {
    var self = this;
    self._queue.queueTask(function () {
      if (self._ready())
        throw Error("can't make ObserveMultiplex ready twice!");
      self._readyFuture.return();
    });
  },
  // Calls "cb" once the effects of all "ready", "addHandleAndSendInitialAdds"
  // and observe callbacks which came before this call have been propagated to
  // all handles. "ready" must have already been called on this multiplexer.
  onFlush: function (cb) {
    var self = this;
    self._queue.queueTask(function () {
      if (!self._ready())
        throw Error("only call onFlush on a multiplexer that will be ready");
      cb();
    });
  },
  callbackNames: function () {
    var self = this;
    if (self._ordered)
      return ["addedBefore", "changed", "movedBefore", "removed"];
    else
      return ["added", "changed", "removed"];
  },
  _ready: function () {
    return this._readyFuture.isResolved();
  },
  _applyCallback: function (callbackName, args) {
    var self = this;
    self._queue.queueTask(function () {
      // If we stopped in the meantime, do nothing.
      if (!self._handles)
        return;

      // First, apply the change to the cache.
      // XXX We could make applyChange callbacks promise not to hang on to any
      // state from their arguments (assuming that their supplied callbacks
      // don't) and skip this clone. Currently 'changed' hangs on to state
      // though.
      self._cache.applyChange[callbackName].apply(null, EJSON.clone(args));

      // If we haven't finished the initial adds, then we should only be getting
      // adds.
      if (!self._ready() &&
          (callbackName !== 'added' && callbackName !== 'addedBefore')) {
        throw new Error("Got " + callbackName + " during initial adds");
      }

      // Now multiplex the callbacks out to all observe handles. It's OK if
      // these calls yield; since we're inside a task, no other use of our queue
      // can continue until these are done. (But we do have to be careful to not
      // use a handle that got removed, because removeHandle does not use the
      // queue; thus, we iterate over an array of keys that we control.)
      _.each(_.keys(self._handles), function (handleId) {
        var handle = self._handles && self._handles[handleId];
        if (!handle)
          return;
        var callback = handle['_' + callbackName];
        // clone arguments so that callbacks can mutate their arguments
        callback && callback.apply(null, EJSON.clone(args));
      });
    });
  },

  // Sends initial adds to a handle. It should only be called from within a task
  // (the task that is processing the addHandleAndSendInitialAdds call). It
  // synchronously invokes the handle's added or addedBefore; there's no need to
  // flush the queue afterwards to ensure that the callbacks get out.
  _sendAdds: function (handle) {
    var self = this;
    if (self._queue.safeToRunTask())
      throw Error("_sendAdds may only be called from within a task!");
    var add = self._ordered ? handle._addedBefore : handle._added;
    if (!add)
      return;
    // note: docs may be an _IdMap or an OrderedDict
    self._cache.docs.forEach(function (doc, id) {
      if (!_.has(self._handles, handle._id))
        throw Error("handle got removed before sending initial adds!");
      var fields = EJSON.clone(doc);
      delete fields._id;
      if (self._ordered)
        add(id, fields, null); // we're going in order, so add at end
      else
        add(id, fields);
    });
  }
});


var nextObserveHandleId = 1;
ObserveHandle = function (multiplexer, callbacks) {
  var self = this;
  // The end user is only supposed to call stop().  The other fields are
  // accessible to the multiplexer, though.
  self._multiplexer = multiplexer;
  _.each(multiplexer.callbackNames(), function (name) {
    if (callbacks[name]) {
      self['_' + name] = callbacks[name];
    } else if (name === "addedBefore" && callbacks.added) {
      // Special case: if you specify "added" and "movedBefore", you get an
      // ordered observe where for some reason you don't get ordering data on
      // the adds.  I dunno, we wrote tests for it, there must have been a
      // reason.
      self._addedBefore = function (id, fields, before) {
        callbacks.added(id, fields);
      };
    }
  });
  self._stopped = false;
  self._id = nextObserveHandleId++;
};
ObserveHandle.prototype.stop = function () {
  var self = this;
  if (self._stopped)
    return;
  self._stopped = true;
  self._multiplexer.removeHandle(self._id);
};
