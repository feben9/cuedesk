// Cue UI: plain JavaScript, no build step, no external requests.
// All text is inserted with textContent, never as HTML.
(function () {
  'use strict';

  var REFRESH_MS = 5000;
  var STAGES = [
    ['todo', 'To do'],
    ['active', 'Active'],
    ['review', 'Review'],
    ['blocked', 'Blocked'],
    ['done', 'Done'],
  ];
  var LAST_VISIT_KEY = 'cue.lastVisit';

  var state = null;
  var view = 'needs';
  var openForms = {}; // ask id -> draft text, while an answer form is open
  var briefSince = null;

  // ------------------------------------------------------------ helpers

  function $(id) {
    return document.getElementById(id);
  }

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) el.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
      else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  function span(ms) {
    ms = Math.max(0, ms);
    var m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm';
    var hrs = Math.floor(m / 60);
    if (hrs < 24) return hrs + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
    var d = Math.floor(hrs / 24);
    return d + 'd' + (hrs % 24 ? ' ' + (hrs % 24) + 'h' : '');
  }

  function ago(isoText) {
    if (!isoText) return '';
    var s = span(Date.now() - Date.parse(isoText));
    return s === 'just now' ? s : s + ' ago';
  }

  function clock(isoText) {
    if (!isoText) return '';
    var d = new Date(isoText);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function full(isoText) {
    return isoText ? new Date(isoText).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  }

  function toast(message, isError) {
    var t = $('toast');
    t.textContent = message;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, isError ? 6000 : 2500);
  }

  function api(method, path, body) {
    var opts = { method: method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || data.ok === false) throw new Error(data.error || data.message || res.status + ' ' + res.statusText);
        return data;
      });
    });
  }

  // ------------------------------------------------------------ data

  function refresh() {
    return api('GET', '/api/state')
      .then(function (data) {
        state = data;
        setLive(true);
        render();
      })
      .catch(function () {
        setLive(false);
      });
  }

  function setLive(ok) {
    $('live-dot').className = 'dot ' + (ok ? 'live' : 'down');
    $('live-text').textContent = ok ? 'updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Cue is not reachable';
  }

  function act(method, path, body, done) {
    return api(method, path, body)
      .then(function () {
        if (done) toast(done);
        return refresh();
      })
      .catch(function (err) {
        toast(err.message, true);
      });
  }

  // ------------------------------------------------------------ routing

  function setView(name) {
    if (['needs', 'now', 'board', 'since'].indexOf(name) < 0) name = 'needs';
    view = name;
    document.querySelectorAll('.view').forEach(function (s) { s.hidden = s.id !== 'view-' + name; });
    document.querySelectorAll('.tabs a').forEach(function (a) {
      if (a.getAttribute('data-view') === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    if (name === 'since' && briefSince === null) loadBrief(defaultSince());
    else render();
  }

  // ------------------------------------------------------------ render

  function render() {
    if (!state) return;
    $('project').textContent = state.project + (state.preset ? ' · ' + state.preset : '');
    document.title = (state.whatsNext.counts.urgent ? '(' + state.whatsNext.counts.urgent + '!) ' : state.whatsNext.needs.length ? '(' + state.whatsNext.needs.length + ') ' : '') + 'Cue · ' + state.project;
    var count = $('needs-count');
    count.textContent = String(state.whatsNext.needs.length);
    count.className = 'count' + (state.whatsNext.counts.urgent ? ' hot' : '');
    if (view === 'needs') renderNeeds();
    if (view === 'now') renderNow();
    if (view === 'board') renderBoard();
  }

  function renderNeeds() {
    var wn = state.whatsNext;
    var c = wn.counts;
    var parts = [c.asks + ' asks', c.signals + ' signals'];
    if (c.urgent) parts.push(c.urgent + ' urgent');
    if (c.snoozed) parts.push(c.snoozed + ' snoozed');
    $('needs-sub').textContent = (wn.quietHours ? 'Quiet hours: non-urgent signals wait for the brief. ' : '') + parts.join(' · ') + '. Most pressing first.';

    // Don't rebuild the list under someone who is typing an answer.
    var list = $('needs-list');
    if (Object.keys(openForms).length && list.contains(document.activeElement)) return;
    clear(list);
    if (!wn.needs.length) {
      list.appendChild(h('li', { class: 'empty' }, 'Nothing needs you right now. Asks from sessions and signals from the watch rules land here.'));
    }
    wn.needs.forEach(function (e, i) { list.appendChild(card(e, i + 1)); });

    var held = $('held');
    held.hidden = !wn.held.length;
    if (wn.held.length) {
      $('held-summary').textContent = wn.held.length + ' signals held for the brief (quiet hours)';
      var hl = clear($('held-list'));
      wn.held.forEach(function (e) { hl.appendChild(card(e, null)); });
    }
  }

  function kindLabel(e) {
    if (e.type === 'signal') return e.subjectType === 'item' ? 'Board' : e.subjectType === 'session' ? 'Session' : 'Signal';
    if (e.origin === 'hook') return 'Waiting in terminal';
    return { answer: 'Question', approve: 'Approval', action: 'Action' }[e.kind] || 'Ask';
  }

  function card(e, rank) {
    var li = h('li', { class: 'card type-' + e.type + ' sev-' + e.severity });
    if (rank) li.appendChild(h('span', { class: 'rank', title: 'Rank in whats_next' }, '#' + rank));
    // Tags the "why" chip already names ("tagged dev") aren't shown twice.
    var namedTags = /^tagged /.test(e.why) ? e.why.slice(7).toLowerCase().split(', ') : [];
    var chips = h('div', { class: 'row chips-row' },
      h('span', { class: 'chip ' + (e.severity === 'urgent' ? 'urgent' : e.type === 'ask' ? 'ask' : e.severity) }, kindLabel(e)),
      e.severity === 'urgent' ? h('span', { class: 'chip urgent' }, e.overdue ? 'Overdue' : 'Urgent') : null,
      h('span', { class: 'chip why', title: 'Why it is here' }, e.why),
      (e.tags || []).filter(function (t) { return namedTags.indexOf(t.toLowerCase()) < 0; }).map(function (t) { return h('span', { class: 'chip' }, '#' + t); }),
    );
    li.appendChild(chips);
    li.appendChild(h('div', { class: 'title' }, e.title));
    if (e.detail) li.appendChild(h('p', { class: 'detail' }, e.detail));
    (e.flags || []).forEach(function (f) {
      li.appendChild(h('div', { class: 'flag sev-' + f.severity }, 'Flag: ' + f.title));
    });

    var meta = [];
    if (e.type === 'ask') {
      meta.push('from ' + (e.sessionLabel || e.askedBy));
      meta.push('asked ' + ago(e.createdAt) + ' (' + clock(e.createdAt) + ')');
      if (e.dueAt) meta.push(e.overdue ? 'was due ' + ago(e.dueAt) : 'due in ' + span(Date.parse(e.dueAt) - Date.now()) + ' (' + clock(e.dueAt) + ')');
      if (e.origin === 'hook') meta.push('answer it in that terminal; Cue clears this when the session moves on');
    } else {
      meta.push('raised ' + ago(e.createdAt) + ' (' + clock(e.createdAt) + ')');
    }
    li.appendChild(h('div', { class: 'meta', title: full(e.createdAt) }, meta.join(' · ')));

    var actions = h('div', { class: 'actions' });
    var base = e.type === 'ask' ? '/api/asks/' + encodeURIComponent(e.id) : '/api/signals/' + encodeURIComponent(e.id);
    var who = e.sessionLabel || e.askedBy || 'the asker';
    e.actions.forEach(function (a) {
      if (a === 'answer') actions.appendChild(h('button', { type: 'button', class: 'btn small primary', onclick: function () { openForms[e.id] = openForms[e.id] || ''; renderNeedsForce(); } }, 'Answer'));
      if (a === 'approve') actions.appendChild(h('button', { type: 'button', class: 'btn small primary', onclick: function () { act('POST', base + '/approve', {}, 'Approved. ' + who + ' will see it.'); } }, 'Approve'));
      if (a === 'reject') actions.appendChild(h('button', { type: 'button', class: 'btn small', onclick: function () { act('POST', base + '/reject', {}, 'Rejected. ' + who + ' will see it.'); } }, 'Reject'));
      if (a === 'done') actions.appendChild(h('button', { type: 'button', class: 'btn small' + (e.kind === 'action' ? ' primary' : ''), onclick: function () { act('POST', base + '/done', {}, 'Marked done.'); } }, 'Done'));
      if (a === 'open' && e.link) actions.appendChild(h('a', { class: 'btn small', href: e.link, target: '_blank', rel: 'noopener noreferrer' }, 'Open'));
      if (a === 'dismiss') actions.appendChild(h('button', { type: 'button', class: 'btn small ghost', onclick: function () { act('POST', base + '/dismiss', {}, 'Dismissed.'); } }, 'Dismiss'));
      if (a === 'snooze') actions.appendChild(h('button', { type: 'button', class: 'btn small ghost', title: 'Hide for an hour', onclick: function () { act('POST', base + '/snooze', { minutes: 60 }, 'Snoozed for 1 hour.'); } }, 'Snooze 1h'));
    });
    li.appendChild(actions);

    if (e.type === 'ask' && Object.prototype.hasOwnProperty.call(openForms, e.id)) li.appendChild(answerForm(e, base, who));
    return li;
  }

  function answerForm(e, base, who) {
    var ta = h('textarea', { 'aria-label': 'Your answer', placeholder: 'Your answer goes back to ' + who + '.' });
    ta.value = openForms[e.id] || '';
    ta.addEventListener('input', function () { openForms[e.id] = ta.value; });
    var form = h('form', { class: 'answer-form' },
      ta,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn small ghost', onclick: function () { delete openForms[e.id]; renderNeedsForce(); } }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn small primary' }, 'Send answer'),
      ),
    );
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var text = ta.value.trim();
      if (!text) return ta.focus();
      act('POST', base + '/answer', { answer: text }, 'Answer sent to ' + who + '.').then(function () {
        delete openForms[e.id];
        renderNeedsForce();
      });
    });
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) form.requestSubmit();
    });
    setTimeout(function () { if (document.activeElement === document.body) ta.focus(); }, 0);
    return form;
  }

  function renderNeedsForce() {
    var active = document.activeElement;
    if (active && active.blur) active.blur();
    renderNeeds();
  }

  function stateLabel(s) {
    if (s.flagged) return h('span', { class: 'chip urgent' }, 'Silent ' + s.silentFor);
    var map = { working: ['ok', 'Working'], waiting: ['ask', 'Waiting on you'], idle: ['', 'Idle'], ended: ['', 'Ended'] };
    var m = map[s.state] || ['', s.state];
    return h('span', { class: 'chip ' + m[0] }, m[1]);
  }

  function renderNow() {
    var box = clear($('sessions'));
    if (!state.sessions.length) box.appendChild(h('div', { class: 'empty' }, 'No sessions yet. Sessions appear when Claude Code hooks fire or an agent calls a Cue tool.'));
    state.sessions.forEach(function (s) {
      box.appendChild(h('div', { class: 'session' + (s.flagged ? ' flagged' : '') },
        h('div', { class: 'row' }, h('span', { class: 'label' }, s.label), ' ', stateLabel(s)),
        h('div', { class: 'activity' }, s.activity || 'No activity reported yet.'),
        h('div', { class: 'meta', title: full(s.lastSeen) }, 'Last seen ' + ago(s.lastSeen) + ' (' + clock(s.lastSeen) + ')' + (s.openAsks ? ' · ' + s.openAsks + ' open ask' + (s.openAsks > 1 ? 's' : '') : '') + ' · ' + s.source),
        s.holds.length ? h('div', { class: 'holds' }, s.holds.map(function (c) { return h('span', { class: 'chip warn', title: c.reason }, 'Holds ' + c.resourceId); })) : null,
      ));
    });

    var rbox = clear($('resources'));
    if (!state.resources.length) rbox.appendChild(h('div', { class: 'empty' }, 'No shared resources configured. Add them under "resources" in cue.config.yaml.'));
    state.resources.forEach(function (r) {
      var holder = r.holder;
      rbox.appendChild(h('div', { class: 'resource' },
        h('div', null, h('div', { class: 'rid' }, r.id), h('div', { class: 'kind' }, r.kind + (r.label !== r.id ? ' · ' + r.label : ''))),
        holder
          ? h('div', { class: 'holder' },
              h('div', null, 'Held by ', h('strong', null, holder.label)),
              h('div', { class: 'meta', title: 'Since ' + full(holder.since) + ', until ' + full(holder.expiresAt) }, '"' + holder.reason + '" · since ' + clock(holder.since) + ' · until ' + clock(holder.expiresAt)))
          : h('div', { class: 'holder' }, h('span', { class: 'chip ok' }, 'Free')),
        holder
          ? h('button', { type: 'button', class: 'btn small danger', onclick: function () {
              if (confirm('Release ' + r.id + ' from ' + holder.label + '? The session will not be told directly.')) act('POST', '/api/resources/' + encodeURIComponent(r.id) + '/release', {}, r.id + ' released.');
            } }, 'Release')
          : h('span'),
      ));
    });
  }

  function renderBoard() {
    var items = state.board;
    var stale = items.filter(function (i) { return i.stale; }).length;
    var sub = $('board-sub');
    clear(sub);
    sub.appendChild(document.createTextNode(items.length + ' items · ' + stale + ' stale. '));
    if (!state.sources.length) sub.appendChild(document.createTextNode('No sources configured.'));
    state.sources.forEach(function (s, i) {
      sub.appendChild(h('span', { class: 'sources-line' },
        (i ? ' · ' : '') + s.name + ' (' + s.type + '): ' + (s.lastSync ? 'read ' + ago(s.lastSync) : 'not read yet'),
        s.error ? h('span', { class: 'err' }, ' · ' + s.error) : null));
    });

    var cols = clear($('columns'));
    STAGES.forEach(function (st) {
      var inStage = items.filter(function (i) { return i.stage === st[0]; });
      inStage.sort(function (a, b) { return (b.stale ? 1 : 0) - (a.stale ? 1 : 0) || b.idleMs - a.idleMs; });
      var ul = h('ul', { class: 'items' });
      inStage.forEach(function (i) {
        var sev = i.stale ? ' stale sev-' + i.stale.severity : '';
        ul.appendChild(h('li', { class: 'item' + sev },
          h('div', { class: 'iid' }, i.id + (state.sources.length > 1 ? ' · ' + i.source : '')),
          i.url ? h('a', { class: 'ititle', href: i.url, target: '_blank', rel: 'noopener noreferrer' }, i.title) : h('span', { class: 'ititle' }, i.title),
          h('div', { class: 'meta', title: 'Updated ' + full(i.updatedAt) }, i.status + (i.assignee ? ' · ' + i.assignee : '') + (i.stale ? '' : ' · updated ' + ago(i.updatedAt))),
          i.stale ? h('div', { class: 'stale-note' }, 'Stale: no update for ' + i.idleFor) : null,
        ));
      });
      if (!inStage.length) ul.appendChild(h('li', { class: 'meta' }, 'Nothing here.'));
      cols.appendChild(h('section', { class: 'column', 'aria-label': st[1] }, h('h3', null, h('span', null, st[1]), h('span', null, String(inStage.length))), ul));
    });

    var rules = clear($('rules'));
    if (!state.rules.length) rules.appendChild(h('li', null, 'No rules configured.'));
    state.rules.forEach(function (r) {
      rules.appendChild(h('li', null, h('code', null, r.id), ': ' + r.describe + ' (' + r.severity + ')'));
    });
  }

  // ------------------------------------------------------------ since / brief

  function readLastVisit() {
    try {
      var v = localStorage.getItem(LAST_VISIT_KEY);
      return v ? Number(v) : null;
    } catch (e) {
      return null;
    }
  }

  function saveLastVisit() {
    try {
      localStorage.setItem(LAST_VISIT_KEY, String(Date.now()));
    } catch (e) {
      // Storage may be blocked; the other ranges still work.
    }
  }

  var lastVisit = readLastVisit();

  function defaultSince() {
    return lastVisit && Date.now() - lastVisit > 5 * 60000 ? lastVisit : Date.now() - 8 * 3600000;
  }

  function toLocalInput(ms) {
    var d = new Date(ms);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function loadBrief(sinceMs) {
    briefSince = sinceMs;
    $('since-input').value = toLocalInput(sinceMs);
    return api('GET', '/api/since?timestamp=' + encodeURIComponent(new Date(sinceMs).toISOString()))
      .then(renderBrief)
      .catch(function (err) { toast(err.message, true); });
  }

  var EVENT_LABELS = { ask: ['ask', 'Ask'], signal: ['warn', 'Signal'], item: ['', 'Board'], source: ['', 'Board'], session: ['', 'Session'], claim: ['', 'Resource'], progress: ['ok', 'Progress'] };

  function eventChip(type) {
    var m = EVENT_LABELS[type.split('.')[0]] || ['', type];
    if (type === 'signal.fired' || type === 'source.error') m = ['warn', m[1]];
    if (type === 'signal.resolved' || type === 'signal.dismissed') m = ['', 'Signal'];
    return h('span', { class: 'chip ' + m[0], title: type }, m[1]);
  }

  function renderBrief(b) {
    var box = clear($('brief'));
    box.appendChild(h('p', { class: 'headline' }, b.headline));
    box.appendChild(h('p', { class: 'sub' }, 'From ' + full(b.since) + ' to ' + full(b.until) + '.'));
    if (b.highlights.length) box.appendChild(h('ul', { class: 'highlights' }, b.highlights.map(function (t) { return h('li', null, t); })));
    if (!b.events.length) return;
    box.appendChild(h('h2', null, 'Timeline' + (b.totalEvents > b.events.length ? ' (latest ' + b.events.length + ' of ' + b.totalEvents + ')' : '')));
    var ol = h('ol', { class: 'timeline' });
    var lastDay = '';
    b.events.slice().reverse().forEach(function (e) {
      var day = new Date(e.ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
      if (day !== lastDay) {
        ol.appendChild(h('li', { class: 'day' }, day));
        lastDay = day;
      }
      ol.appendChild(h('li', null, h('span', { class: 'when', title: full(e.ts) }, clock(e.ts)), eventChip(e.type), ' ', e.summary));
    });
    box.appendChild(ol);
  }

  // ------------------------------------------------------------ wiring

  window.addEventListener('hashchange', function () { setView(location.hash.slice(1)); });
  document.querySelectorAll('[data-since]').forEach(function (b) {
    b.addEventListener('click', function () {
      var v = b.getAttribute('data-since');
      var hours = { '1h': 1, '8h': 8, '24h': 24 }[v];
      if (v === 'last') {
        if (!lastVisit) return toast('No earlier visit recorded in this browser yet.');
        return loadBrief(lastVisit);
      }
      loadBrief(Date.now() - hours * 3600000);
    });
  });
  $('since-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var ms = Date.parse($('since-input').value);
    if (Number.isNaN(ms)) return toast('Pick a date and time first.', true);
    loadBrief(ms);
  });
  $('sync-btn').addEventListener('click', function () {
    var btn = $('sync-btn');
    btn.disabled = true;
    api('POST', '/api/sync', {})
      .then(function (r) {
        var bad = r.sources.filter(function (s) { return !s.ok; });
        toast(bad.length ? bad[0].source + ': ' + bad[0].error : 'Read ' + r.sources.length + ' source' + (r.sources.length === 1 ? '' : 's') + '.', bad.length > 0);
        return refresh();
      })
      .catch(function (err) { toast(err.message, true); })
      .then(function () { btn.disabled = false; });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') saveLastVisit();
    else refresh();
  });
  window.addEventListener('pagehide', saveLastVisit);

  setView(location.hash.slice(1) || 'needs');
  refresh();
  var ticks = 0;
  setInterval(function () {
    if (document.visibilityState !== 'visible') return;
    refresh();
    ticks++;
    // The brief changes slowly; refresh it every 30 s, and not while a date is being edited.
    if (view === 'since' && briefSince !== null && ticks % 6 === 0 && !document.activeElement.matches('input')) loadBrief(briefSince);
  }, REFRESH_MS);
})();
