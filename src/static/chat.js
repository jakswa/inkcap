// M3's crude live-tail island: subscribe to the conversation's SSE stream and
// append plain-text deltas. Replay starts from seq 1, so the first delta for a
// message clears the SSR-rendered partial before rebuilding — the flushed
// deltas and the persisted row are the same bytes. M4 replaces this file.
(function () {
  var root = document.querySelector('[data-chat]');
  if (!root || !root.hasAttribute('data-active')) return;
  var es = new EventSource(root.getAttribute('data-events'));
  var seen = {};
  function find(id) {
    return root.querySelector('[data-message-id="' + id + '"]');
  }
  es.addEventListener('delta', function (e) {
    var d = JSON.parse(e.data);
    var node = find(d.messageId);
    if (!node) return location.reload();
    if (!seen[d.messageId]) {
      seen[d.messageId] = true;
      var pres = node.querySelectorAll('[data-content], [data-reasoning]');
      for (var i = 0; i < pres.length; i++) pres[i].textContent = '';
    }
    var c = node.querySelector('[data-content]');
    var r = node.querySelector('[data-reasoning]');
    if (d.content && c) c.textContent += d.content;
    if (d.reasoning && r) r.textContent += d.reasoning;
  });
  es.addEventListener('message-final', function (e) {
    var d = JSON.parse(e.data);
    var node = find(d.messageId);
    if (!node) return location.reload();
    node.outerHTML = d.html;
  });
  es.addEventListener('run-status', function (e) {
    var d = JSON.parse(e.data);
    if (d.status !== 'running') {
      es.close();
      location.reload();
    }
  });
})();
