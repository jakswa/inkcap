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

  function isStandaloneDisplay() {
    return Boolean(
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        window.navigator.standalone === true
    );
  }

  function installStandaloneViewportFix() {
    if (!document.body || !document.body.classList.contains('chat-shell')) return;
    if (!isStandaloneDisplay() || !window.visualViewport) return;

    var scheduled = false;
    var apply = function () {
      scheduled = false;
      var height = Number(window.visualViewport.height || window.innerHeight || 0);
      if (height > 0) document.documentElement.style.setProperty('--chat-shell-height', height + 'px');
    };
    var schedule = function () {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(apply);
    };

    schedule();
    window.visualViewport.addEventListener('resize', schedule, { passive: true });
    window.visualViewport.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('orientationchange', schedule, { passive: true });
  }

  installStandaloneViewportFix();

  var es = null; // active EventSource, if any
  var statusTimer = null;
  var streamOpenedAt = 0;
  var sawOutput = false;
  var sawProgress = false;
  var statusPhase = '';
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

  function updateToolsCountFrom(input) {
    var details = input && input.closest ? input.closest('details') : null;
    if (!details) return;
    var countEl = details.querySelector('[data-tools-count]');
    if (!countEl) return;
    var boxes = details.querySelectorAll('input[name="enabled_mcp_server_id"]');
    var count = 0;
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].checked && boxes[i].getAttribute('data-mcp-global-enabled') !== '0') count += 1;
    }
    countEl.textContent = String(count);
    countEl.classList.toggle('hidden', count === 0);
  }

  function compactNumber(value) {
    var n = Number(value || 0);
    if (!Number.isFinite(n)) return '0';
    if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1).replace(/\.0$/, '') + 'm';
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  }

  function compactRate(value) {
    var n = Number(value || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    return (n >= 10 ? Math.round(n) : Number(n.toFixed(1))) + '/s';
  }

  function setStatus(text, title) {
    var r = root();
    if (!r) return;
    var strip = r.querySelector('[data-status]');
    var textEl = r.querySelector('[data-status-text]');
    if (textEl) {
      textEl.textContent = text || '';
      textEl.title = title || text || '';
    }
    if (strip) strip.classList.toggle('hidden', !text);
  }

  function stopStatusTimer() {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  }

  function startWaitingStatus() {
    stopStatusTimer();
    streamOpenedAt = Date.now();
    sawOutput = false;
    sawProgress = false;
    statusPhase = 'waiting';
    var update = function () {
      if (sawOutput || sawProgress) return;
      var seconds = Math.floor((Date.now() - streamOpenedAt) / 1000);
      setStatus(seconds > 0 ? 'Waiting… ' + seconds + 's' : 'Waiting…', seconds > 0 ? 'Waiting for model… ' + seconds + 's' : 'Waiting for model…');
    };
    update();
    statusTimer = setInterval(update, 1000);
  }

  function markOutputStarted() {
    sawOutput = true;
    stopStatusTimer();
    if (statusPhase !== 'generation') {
      statusPhase = 'generation';
      setStatus('Generating…');
    }
  }

  function updateLiveStatus(stats) {
    if (!stats) return;
    sawProgress = true;
    if (stats.generation && Number(stats.generation.tokens || 0) > 0) {
      var tokens = Number(stats.generation.tokens || 0);
      var rate = compactRate(stats.generation.rate);
      sawOutput = true;
      stopStatusTimer();
      statusPhase = 'generation';
      setStatus('Gen ' + compactNumber(tokens) + (rate ? ' · ' + rate : ''), 'Generating… ' + tokens.toLocaleString() + ' tokens' + (stats.generation.rate ? ' · ' + Number(stats.generation.rate).toFixed(1) + ' tok/s' : ''));
      return;
    }
    if (stats.prompt) {
      stopStatusTimer();
      statusPhase = 'prompt';
      var done = Number(stats.prompt.processed || 0);
      var total = Number(stats.prompt.total || 0);
      var promptRate = compactRate(stats.prompt.rate);
      setStatus('Input ' + compactNumber(done) + (total > 0 ? '/' + compactNumber(total) : '') + (promptRate ? ' · ' + promptRate : ''),
        (total > 0
          ? 'Processing prompt… ' + done.toLocaleString() + '/' + total.toLocaleString() + ' tokens'
          : 'Processing prompt… ' + done.toLocaleString() + ' tokens') +
        (stats.prompt.rate ? ' · ' + Number(stats.prompt.rate).toFixed(1) + ' tok/s' : ''));
    }
  }

  function closeStream() {
    stopStatusTimer();
    if (es) {
      es.close();
      es = null;
    }
  }

  function refreshChat(statusText) {
    fetch(location.href)
      .then(function (res) {
        return res.text();
      })
      .then(function (html) {
        swap(html, { preserveComposer: true });
        if (statusText) setStatus(statusText);
      })
      .catch(function () {
        location.reload();
      });
  }

  function appendDeltaText(node, selector, text, offset) {
    if (!text) return false;
    var el = node.querySelector(selector);
    if (!el) return false;
    if (typeof offset !== 'number') {
      el.textContent += text;
      return true;
    }
    var current = el.textContent.length;
    var end = offset + text.length;
    if (current >= end) return false; // already represented by the SSR snapshot
    if (current > offset) {
      el.textContent += text.slice(current - offset);
      return true;
    }
    if (current === offset) {
      el.textContent += text;
      return true;
    }
    // We missed an earlier patch. The server owns truth, so resync instead of
    // guessing and corrupting the reasoning/content panes.
    refreshChat();
    return false;
  }

  function openStream() {
    var r = root();
    if (!r || !r.hasAttribute('data-active')) return;
    closeStream();
    es = new EventSource(r.getAttribute('data-events'));
    startWaitingStatus();

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
      if (d.html) {
        t.insertAdjacentHTML('beforeend', d.html);
      } else {
        var article = document.createElement('article');
        article.className = 'group grid gap-3.5 py-1';
        article.setAttribute('data-message-id', d.messageId);
        article.setAttribute('data-role', d.role || 'assistant');
        article.setAttribute('data-status', 'streaming');
        article.innerHTML =
          '<pre class="m-0 hidden rounded-2xl border border-edge bg-raised/60 px-4 py-3 font-body text-sm whitespace-pre-wrap break-words text-ink-dim [&:not(:empty)]:block" data-reasoning></pre>' +
          '<pre class="m-0 hidden rounded-3xl rounded-bl-lg border border-edge bg-raised/35 px-4 py-3.5 font-body whitespace-pre-wrap break-words text-ink shadow-sm shadow-black/5 [&:not(:empty)]:block" data-content></pre>';
        t.appendChild(article);
      }
      if (pinned) scrollToBottom();
    });

    es.addEventListener('run-progress', function (e) {
      updateLiveStatus(JSON.parse(e.data));
    });

    es.addEventListener('delta', function (e) {
      var d = JSON.parse(e.data);
      var node = find(d.messageId);
      if (!node) return;
      var appended = appendDeltaText(node, '[data-content]', d.content, d.contentOffset);
      appended = appendDeltaText(node, '[data-reasoning]', d.reasoning, d.reasoningOffset) || appended;
      if (appended) markOutputStarted();
      if (appended && pinned) scrollToBottom();
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
      refreshChat(after);
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
      .then(function (html) {
        swap(html, { preserveComposer: false });
      })
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

  function syncReasoningControl(input) {
    if (!input || !input.form) return;
    var supported = input.getAttribute && input.getAttribute('data-reasoning') === '1';
    if (input.options) {
      var option = input.options[input.selectedIndex];
      supported = option && option.getAttribute('data-reasoning') === '1';
    }
    var control = input.form.querySelector('[data-reasoning-control]');
    var hidden = input.form.querySelector('[data-reasoning-hidden]');
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

  function syncModelState(input) {
    var menu = input.closest('[data-model-menu]');
    if (!menu) return;
    var label = input.getAttribute('data-label') || input.value;
    menu.title = 'Model: ' + label;
    var summary = menu.querySelector('summary');
    if (summary) summary.setAttribute('aria-label', 'Model: ' + label);
    var text = menu.querySelector('[data-model-label]');
    if (text) text.textContent = label;
    menu.open = false;
  }

  function snapshotComposerState(container) {
    var state = [];
    if (!container) return state;
    var fields = container.querySelectorAll('textarea[name], select[name], input[name]');
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      var type = (field.getAttribute('type') || field.tagName || '').toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'button') continue;
      if (type === 'radio') {
        if (field.checked) state.push({ kind: 'radio', name: field.name, value: field.value });
      } else if (type === 'checkbox') {
        state.push({ kind: 'checkbox', name: field.name, value: field.value, checked: field.checked });
      } else {
        state.push({ kind: 'value', name: field.name, value: field.value });
      }
    }
    return state;
  }

  function restoreComposerState(container, state) {
    if (!container || !state || state.length === 0) return;
    var fields = container.querySelectorAll('textarea[name], select[name], input[name]');
    for (var i = 0; i < state.length; i++) {
      var item = state[i];
      for (var j = 0; j < fields.length; j++) {
        var field = fields[j];
        var type = (field.getAttribute('type') || field.tagName || '').toLowerCase();
        if (field.name !== item.name) continue;
        if (item.kind === 'radio' && type === 'radio' && field.value === item.value) {
          field.checked = true;
          break;
        }
        if (item.kind === 'checkbox' && type === 'checkbox' && field.value === item.value) {
          field.checked = !!item.checked;
          break;
        }
        if (item.kind === 'value' && type !== 'hidden' && type !== 'radio' && type !== 'checkbox') {
          field.value = item.value;
          break;
        }
      }
    }
    var box = container.querySelector('input[name="enabled_mcp_server_id"]');
    if (box) updateToolsCountFrom(box);
  }

  function positionMenu(details) {
    if (!details || !details.open) return;
    var panel = details.querySelector('[data-menu-panel]');
    if (!panel) return;
    panel.style.top = '';
    panel.style.right = '';
    panel.style.bottom = '';
    panel.style.left = '';
    panel.style.marginTop = '';
    panel.style.marginBottom = '';
    var rect = details.getBoundingClientRect();
    var panelHeight = panel.offsetHeight || 0;
    var spaceAbove = rect.top;
    var spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow > spaceAbove || spaceAbove < panelHeight + 12) {
      panel.style.top = '100%';
      panel.style.bottom = 'auto';
      panel.style.marginTop = '0.5rem';
      panel.style.marginBottom = '0';
    } else {
      panel.style.top = 'auto';
      panel.style.bottom = '100%';
      panel.style.marginTop = '0';
      panel.style.marginBottom = '0.5rem';
    }

    var panelRect = panel.getBoundingClientRect();
    var gutter = 8;
    var desiredLeft = Math.max(
      gutter,
      Math.min(panelRect.left, window.innerWidth - panelRect.width - gutter),
    );
    if (Math.abs(desiredLeft - panelRect.left) > 1) {
      panel.style.left = desiredLeft - rect.left + 'px';
      panel.style.right = 'auto';
    }
  }

  // Replace #chat with the server's fresh render, then re-attach behavior and
  // re-open the live tail if a run is now active.
  function swap(html, options) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var fresh = doc.getElementById('chat');
    var cur = root();
    if (!fresh || !cur) {
      location.reload();
      return;
    }
    var shouldPreserveComposer = !options || options.preserveComposer !== false;
    var oldState = shouldPreserveComposer
      ? snapshotComposerState(cur.querySelector('[data-controls]'))
      : [];
    closeStream();
    cur.replaceWith(fresh);
    if (shouldPreserveComposer) restoreComposerState(fresh.querySelector('[data-controls]'), oldState);
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
    if (el && el.matches && el.matches('input[name="enabled_mcp_server_id"]')) updateToolsCountFrom(el);
    if (el && el.matches && el.matches('[data-model-select]')) syncReasoningControl(el);
    if (el && el.matches && el.matches('[data-model-radio]')) {
      syncModelState(el);
      syncReasoningControl(el);
    }
    if (el && el.matches && el.matches('select[name="reasoning_effort"], [data-reasoning-radio]')) syncReasoningState(el);
  });

  document.addEventListener(
    'toggle',
    function (e) {
      var el = e.target;
      if (el && el.matches && el.matches('details[data-close-on-outside][open]')) positionMenu(el);
    },
    true,
  );

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

  window.addEventListener('resize', function () {
    var menus = document.querySelectorAll('details[data-close-on-outside][open]');
    for (var i = 0; i < menus.length; i++) positionMenu(menus[i]);
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
      var model = document.querySelector('[data-model-radio]:checked, [data-model-select]:not([data-model-radio])');
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
    var model = r.querySelector('[data-model-radio]:checked, [data-model-select]:not([data-model-radio])');
    if (model) {
      syncModelState(model);
      syncReasoningControl(model);
    }
    var reasoning = r.querySelector('[data-reasoning-radio]:checked');
    if (reasoning) syncReasoningState(reasoning);
    openStream();
  }

  init();
  scrollToBottom();
})();
