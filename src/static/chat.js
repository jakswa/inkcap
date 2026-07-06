// The one rich island (THE_PLAN: "the chat view"). Vanilla, no build step.
//
// Responsibilities:
//  - Live tail: open the run's SSE endpoint (EventSource resumes via
//    Last-Event-ID automatically), append plain-text deltas into the streaming
//    bubble, and finalize-swap the server-rendered markdown block on
//    message-final. No client-side markdown — the server owns rendering.
//  - Status strip: reflect run-status; on any terminal status refetch the
//    server's fresh render so the composer, title, and branch switchers are
//    all current.
//  - Composer: intercept submit, POST via fetch, swap in the server's fresh
//    render (new user + streaming bubbles), keep the transcript pinned to the
//    bottom unless the user scrolled up. Enter sends, Shift+Enter newlines,
//    and the textarea grows with its content (also on the landing composer).
//  - Copy buttons ([data-copy]) — clipboard is JS-only, so they're .js-only
//    and hidden until this script stamps html.js.
//
// Everything degrades: with JS off, the SSR transcript plus the <noscript>
// meta-refresh in show-content.eta keep the M3 behavior working.
(function () {
  // Reveal .js-only elements (copy buttons). Lives here, not inline in the
  // layout, because the CSP forbids inline scripts (default-src 'self').
  document.documentElement.classList.add('js');

  var es = null; // active EventSource, if any
  var pinned = true; // stick to the newest tokens unless the user scrolls up

  function root() {
    return document.getElementById('chat');
  }
  function scroller() {
    var r = root();
    return r ? r.querySelector('[data-scroller]') : null;
  }
  function find(id) {
    var r = root();
    return r ? r.querySelector('[data-message-id="' + id + '"]') : null;
  }
  function nearBottom() {
    var s = scroller();
    if (!s) return true;
    return s.scrollTop + s.clientHeight >= s.scrollHeight - 120;
  }
  function scrollToBottom() {
    var s = scroller();
    if (s) s.scrollTop = s.scrollHeight;
  }

  function setStatus(text) {
    var r = root();
    if (!r) return;
    var strip = r.querySelector('[data-status]');
    var textEl = r.querySelector('[data-status-text]');
    if (textEl) textEl.textContent = text || '';
    if (strip) strip.classList.toggle('hidden', !text);
  }

  function closeStream() {
    if (es) {
      es.close();
      es = null;
    }
  }

  var seen = {}; // messageId -> already cleared the SSR partial before rebuild

  function openStream() {
    var r = root();
    if (!r || !r.hasAttribute('data-active')) return;
    closeStream();
    seen = {};
    es = new EventSource(r.getAttribute('data-events'));

    // Mid-run message creation (M6 tool loop): tool results and follow-up
    // assistant turns are born while we watch. Drop a streaming placeholder
    // so deltas have a home; message-final swaps in the settled render.
    es.addEventListener('message-start', function (e) {
      var d = JSON.parse(e.data);
      if (find(d.messageId)) return;
      var t = root() && root().querySelector('[data-transcript]');
      if (!t) return;
      var empty = t.querySelector('[data-empty]');
      if (empty) empty.remove();
      var article = document.createElement('article');
      article.className = 'group grid gap-2';
      article.setAttribute('data-message-id', d.messageId);
      article.setAttribute('data-role', d.role || 'assistant');
      article.setAttribute('data-status', 'streaming');
      // Keep these classes in sync with the streaming branch of message.eta.
      article.innerHTML =
        '<pre class="m-0 hidden rounded-2xl border border-edge bg-raised/60 px-4 py-3 font-body text-sm whitespace-pre-wrap break-words text-ink-dim [&:not(:empty)]:block" data-reasoning></pre>' +
        '<pre class="m-0 font-body whitespace-pre-wrap break-words text-ink" data-content></pre>';
      t.appendChild(article);
      seen[d.messageId] = true; // born empty — nothing to clear on first delta
      if (pinned) scrollToBottom();
    });

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
      } else {
        // A message we never saw start (replay gap): append the settled render.
        var t = root() && root().querySelector('[data-transcript]');
        if (t) t.insertAdjacentHTML('beforeend', d.html);
      }
      if (pinned) scrollToBottom();
    });

    // Any non-running status (done, cancelled, error, waiting_approval):
    // pull the server's fresh render — composer buttons, approval card,
    // branch switchers, and the auto-title all come back current.
    es.addEventListener('run-status', function (e) {
      var d = JSON.parse(e.data);
      if (d.status === 'running') return;
      closeStream();
      var after = '';
      if (d.status === 'cancelled') after = 'Stopped.';
      else if (d.status === 'error') after = 'Error: ' + (d.error || 'the run failed.');
      fetch(location.href)
        .then(function (res) {
          return res.text();
        })
        .then(function (html) {
          swap(html);
          if (after) setStatus(after);
        })
        .catch(function () {
          location.reload();
        });
    });

    // On transient network drops EventSource reconnects on its own with the
    // Last-Event-ID header; the server replays after that cursor. Nothing to do.
    es.onerror = function () {};
  }

  function onSend(e) {
    e.preventDefault();
    var form = e.currentTarget;
    var input = form.querySelector('[data-composer-input]');
    if (input && input.value.trim() === '') return;
    var btn = form.querySelector('button[type="submit"]:not([form])');
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

  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 256) + 'px';
  }

  function syncReasoningControl(select) {
    if (!select || !select.form) return;
    var option = select.options[select.selectedIndex];
    var supported = option && option.getAttribute('data-reasoning') === '1';
    var control = select.form.querySelector('[data-reasoning-control]');
    var hidden = select.form.querySelector('[data-reasoning-hidden]');
    var effort = control ? control.querySelector('select[name="reasoning_effort"]') : null;
    var radios = control ? control.querySelectorAll('[data-reasoning-radio]') : [];
    if (control) control.classList.toggle('hidden', !supported);
    if (hidden) hidden.disabled = !!supported;
    if (effort) effort.disabled = !supported;
    for (var i = 0; i < radios.length; i++) radios[i].disabled = !supported;
  }

  // The reasoning control is an icon-only button (lit bulb when on) backed by
  // theme-styled radio options; mirror its value onto the wrapper so CSS can
  // restyle, and surface the level in the tooltip/accessible label.
  function syncReasoningState(input) {
    var control = input.closest('[data-reasoning-control]');
    if (!control) return;
    if (input.value === 'off') control.removeAttribute('data-on');
    else control.setAttribute('data-on', '');
    var label = input.getAttribute('data-label') || input.value;
    if (input.options) {
      var option = input.options[input.selectedIndex];
      label = option ? option.textContent : label;
    }
    control.title = 'Reasoning: ' + label;
    var summary = control.querySelector('summary');
    if (summary) summary.setAttribute('aria-label', 'Reasoning: ' + label);
    var srLabel = control.querySelector('[data-reasoning-label]');
    if (srLabel) srLabel.textContent = 'Reasoning: ' + label;
    if (input.matches && input.matches('[data-reasoning-radio]')) control.open = false;
  }

  function syncProviderControls(select) {
    if (!select || !select.form) return;
    var option = select.options[select.selectedIndex];
    var modelSelect = select.form.querySelector('[data-model-select]');
    if (!option || !modelSelect) return;
    var models = [];
    try {
      models = JSON.parse(option.getAttribute('data-models') || '[]');
    } catch (_) {
      models = [];
    }
    var selected = option.getAttribute('data-default-model') || '';
    modelSelect.textContent = '';
    for (var i = 0; i < models.length; i++) {
      var item = models[i] || {};
      var name = String(item.name || '');
      if (!name) continue;
      var modelOption = new Option(name, name, false, name === selected || (!selected && i === 0));
      modelOption.setAttribute('data-reasoning', item.reasoning ? '1' : '0');
      modelSelect.appendChild(modelOption);
    }
    syncReasoningControl(modelSelect);
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

  // --- one-time delegated handlers (survive #chat swaps) -------------------

  // Enter sends (Shift+Enter for a newline) in any chat composer, including
  // the landing hero. Empty drafts don't submit.
  document.addEventListener('keydown', function (e) {
    var el = e.target;
    if (!el || !el.matches || !el.matches('[data-chat-input]')) return;
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    if (el.value.trim() === '') return;
    if (el.form) el.form.requestSubmit();
  });

  document.addEventListener('input', function (e) {
    var el = e.target;
    if (el && el.matches && el.matches('[data-chat-input]')) autosize(el);
  });

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el && el.matches && el.matches('[data-model-select]')) syncReasoningControl(el);
    if (el && el.matches && el.matches('[data-provider-select]')) syncProviderControls(el);
    if (el && el.matches && el.matches('select[name="reasoning_effort"], [data-reasoning-radio]')) syncReasoningState(el);
  });

  // Theme-styled <details> menus should behave like native popups: clicking
  // elsewhere (or pressing Escape) closes them.
  document.addEventListener('pointerdown', function (e) {
    var target = e.target;
    var menus = document.querySelectorAll('details[data-close-on-outside][open]');
    for (var i = 0; i < menus.length; i++) {
      if (!menus[i].contains(target)) menus[i].removeAttribute('open');
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var menus = document.querySelectorAll('details[data-close-on-outside][open]');
    for (var i = 0; i < menus.length; i++) menus[i].removeAttribute('open');
  });

  // Landing hero: creating an empty conversation from a blank composer is
  // never what anyone means — require some input (message or options).
  document.addEventListener(
    'submit',
    function (e) {
      var form = e.target;
      if (!form || !form.matches || !form.matches('[data-new-chat]')) return;
      var data = new FormData(form);
      var content = String(data.get('content') || '').trim();
      var title = String(data.get('title') || '').trim();
      var system = String(data.get('systemPrompt') || '').trim();
      var tools = data.getAll
        ? data.getAll('enabled_mcp_server_id').some(function (value) {
            return String(value || '').trim() !== '';
          })
        : false;
      if (content === '' && title === '' && system === '' && !tools) {
        e.preventDefault();
        var input = form.querySelector('[data-chat-input]');
        if (input) input.focus();
      }
    },
    true,
  );

  // Copy a message's raw markdown; flash a check as feedback.
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-copy]') : null;
    if (!btn) return;
    var encoded = btn.getAttribute('data-clip') || '';
    var text = '';
    try {
      text = decodeURIComponent(escape(atob(encoded)));
    } catch (_) {
      text = '';
    }
    var write = navigator.clipboard
      ? navigator.clipboard.writeText(text)
      : Promise.reject();
    write.then(function () {
      var prev = btn.innerHTML;
      btn.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
      setTimeout(function () {
        btn.innerHTML = prev;
      }, 1200);
    });
  });

  function init() {
    var r = root();
    if (!r) {
      // Landing page: no island, but autosize the hero composer.
      var hero = document.querySelector('[data-chat-input]');
      if (hero) autosize(hero);
      var provider = document.querySelector('[data-provider-select]');
      if (provider) syncProviderControls(provider);
      var model = document.querySelector('[data-model-select]');
      if (model) syncReasoningControl(model);
      return;
    }
    var composer = r.querySelector('[data-composer]');
    if (composer) composer.addEventListener('submit', onSend);
    var cancel = r.querySelector('[data-cancel]');
    if (cancel) cancel.addEventListener('submit', onCancel);
    var s = scroller();
    if (s) {
      s.addEventListener(
        'scroll',
        function () {
          pinned = nearBottom();
        },
        { passive: true },
      );
    }
    var input = r.querySelector('[data-composer-input]');
    if (input) autosize(input);
    var model = r.querySelector('[data-model-select]');
    if (model) syncReasoningControl(model);
    openStream();
  }

  init();
  scrollToBottom();
})();
