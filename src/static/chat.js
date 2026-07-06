// The one rich island (THE_PLAN: "the chat view"). Vanilla, no build step.
//
// Responsibilities:
//  - Live tail: open the run's SSE endpoint (EventSource resumes via
//    Last-Event-ID automatically), append plain-text deltas into the streaming
//    bubble, and finalize-swap the server-rendered markdown block on
//    message-final. No client-side markdown — the server owns rendering.
//  - Status strip: reflect run-status (streaming / cancelled / error).
//  - Composer: intercept submit, POST via fetch, swap in the server's fresh
//    render (new user + streaming bubbles), clear the box, keep the view
//    pinned to the bottom unless the user scrolled up.
//  - Cancel: intercept the stop form and POST it; the terminal events arrive
//    over SSE.
//
// Everything degrades: with JS off, the SSR transcript plus the <noscript>
// meta-refresh in show-content.eta keep the M3 behavior working.
(function () {
  var es = null; // active EventSource, if any
  var pinned = true; // stick to the newest tokens unless the user scrolls up
  var seen = {}; // messageId -> already cleared the SSR partial before rebuild

  function root() {
    return document.getElementById('chat');
  }
  function find(id) {
    var r = root();
    return r ? r.querySelector('[data-message-id="' + id + '"]') : null;
  }
  function nearBottom() {
    return (
      window.innerHeight + window.scrollY >=
      document.documentElement.scrollHeight - 120
    );
  }
  function scrollToBottom() {
    window.scrollTo(0, document.documentElement.scrollHeight);
  }
  window.addEventListener(
    'scroll',
    function () {
      pinned = nearBottom();
    },
    { passive: true },
  );

  function setStatus(text) {
    var r = root();
    if (!r) return;
    var strip = r.querySelector('[data-status]');
    var textEl = r.querySelector('[data-status-text]');
    if (textEl) textEl.textContent = text || '';
    if (strip) strip.classList.toggle('hidden', !text);
  }
  function hideCancel() {
    var r = root();
    var f = r && r.querySelector('[data-cancel]');
    if (f) f.classList.add('hidden');
  }

  function closeStream() {
    if (es) {
      es.close();
      es = null;
    }
  }

  function openStream() {
    var r = root();
    if (!r || !r.hasAttribute('data-active')) return;
    closeStream();
    seen = {};
    es = new EventSource(r.getAttribute('data-events'));

    es.addEventListener('delta', function (e) {
      var d = JSON.parse(e.data);
      var node = find(d.messageId);
      if (!node) return;
      if (!seen[d.messageId]) {
        // First delta after (re)connect: clear the SSR/replayed partial, then
        // rebuild from the flushed deltas (same bytes as the persisted row).
        seen[d.messageId] = true;
        var pres = node.querySelectorAll('[data-content], [data-reasoning]');
        for (var i = 0; i < pres.length; i++) pres[i].textContent = '';
      }
      var c = node.querySelector('[data-content]');
      var rz = node.querySelector('[data-reasoning]');
      if (d.content && c) c.textContent += d.content;
      if (d.reasoning && rz) rz.textContent += d.reasoning;
      if (pinned) scrollToBottom();
    });

    es.addEventListener('message-final', function (e) {
      var d = JSON.parse(e.data);
      var node = find(d.messageId);
      if (node) {
        node.outerHTML = d.html;
        if (pinned) scrollToBottom();
      }
    });

    es.addEventListener('run-status', function (e) {
      var d = JSON.parse(e.data);
      if (d.status === 'running') return;
      closeStream();
      var r = root();
      if (r) r.removeAttribute('data-active');
      hideCancel();
      if (d.status === 'cancelled') setStatus('Stopped.');
      else if (d.status === 'error') setStatus('Error: ' + (d.error || 'the run failed.'));
      else setStatus('');
    });

    // On transient network drops EventSource reconnects on its own with the
    // Last-Event-ID header; the server replays after that cursor. Nothing to do.
    es.onerror = function () {};
  }

  function onSend(e) {
    e.preventDefault();
    var form = e.currentTarget;
    var btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    fetch(form.action, { method: 'POST', body: new FormData(form) })
      .then(function (res) {
        return res.text();
      })
      .then(swap)
      .catch(function () {
        if (btn) btn.disabled = false;
      });
  }

  function onCancel(e) {
    e.preventDefault();
    var form = e.currentTarget;
    fetch(form.action, { method: 'POST', body: new FormData(form) }).catch(function () {});
    setStatus('Stopping…');
  }

  // Replace #chat with the server's fresh render, then re-attach behavior and
  // re-open the live tail if a run is now active.
  function swap(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var fresh = doc.getElementById('chat');
    var cur = root();
    if (!fresh || !cur) {
      location.reload();
      return;
    }
    closeStream();
    cur.replaceWith(fresh);
    init();
    pinned = true;
    scrollToBottom();
    var input = fresh.querySelector('[data-composer-input]');
    if (input) input.focus();
  }

  function init() {
    var r = root();
    if (!r) return;
    var composer = r.querySelector('[data-composer]');
    if (composer) composer.addEventListener('submit', onSend);
    var cancel = r.querySelector('[data-cancel]');
    if (cancel) cancel.addEventListener('submit', onCancel);
    openStream();
  }

  init();
  scrollToBottom();
})();
