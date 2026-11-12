(function () {
  var path = location.pathname;
  var tr = function (s) { return window.t ? window.t(s) : s; };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST', credentials: 'include', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d._ok = r.ok; return d; }); });
  }

  function hoursLeft(iso) {
    var ms = new Date(iso).getTime() - Date.now();
    if (!(ms > 0)) return 0;
    return Math.max(1, Math.round(ms / 3600000));
  }

  function dashboard() {
    var main = document.querySelector('main.main');
    if (!main) return;
    var bar = el('div', 'dm-bar');
    var left = el('div', 'dm-bar-l');
    left.appendChild(el('span', 'dm-tag', tr('Demo')));
    var txt = el('span', 'dm-txt', tr('No real FIRO.'));
    left.appendChild(txt);
    var end = el('button', 'dm-end', tr('End demo'));
    end.type = 'button';
    end.addEventListener('click', function () {
      end.disabled = true;
      post('/api/auth/logout').then(function () { location.href = '/'; });
    });
    bar.appendChild(left);
    bar.appendChild(end);
    main.insertBefore(bar, main.firstChild);

    fetch('/api/demo/session', { credentials: 'include', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.expires_at) return;
        txt.textContent = tr('No real FIRO.') + ' ' + tr('Deleted in') + ' ' + hoursLeft(d.expires_at) + 'h';
      }).catch(function () {});

    keyButton('spark-viewkey-input', 'spark');
    keyButton('xp-input', 'xpub');
    webhookLog();
  }

  function keyButton(inputId, kind) {
    var input = document.getElementById(inputId);
    if (!input || input.dataset.dmKey) return;
    input.dataset.dmKey = '1';
    var b = el('button', 'dm-key', tr('Use demo key'));
    b.type = 'button';
    b.addEventListener('click', function () {
      fetch('/api/demo/keys', { credentials: 'include', cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          input.value = kind === 'spark' ? d.spark_view_key : d.xpub;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.focus();
        }).catch(function () {});
    });
    input.insertAdjacentElement('afterend', b);
  }

  function checkout() {
    var id = path.split('/')[2];
    var token = new URLSearchParams(location.search).get('t') || '';
    if (!id || id === 'preview' || !token) return;
    var box = el('div', 'dm-pay');
    var head = el('div', 'dm-pay-head');
    head.appendChild(el('span', 'dm-tag', tr('Demo')));
    head.appendChild(el('span', 'dm-txt', tr('No real FIRO. Pay with one tap.')));
    box.appendChild(head);
    var row = el('div', 'dm-pay-row');
    var full = el('button', 'dm-btn dm-btn-main', tr('Simulate payment'));
    var part = el('button', 'dm-btn', tr('Pay half'));
    full.type = part.type = 'button';
    row.appendChild(full);
    row.appendChild(part);
    box.appendChild(row);
    var note = el('div', 'dm-note');
    box.appendChild(note);
    box.hidden = true;
    document.body.appendChild(box);

    var watch = setInterval(function () {
      var step = document.getElementById('step-payment');
      var stripeReady = step && step.offsetParent !== null;
      var themed = document.querySelector('#v2-themes .theme.on');
      var emailStep = document.getElementById('step-email');
      var asking = emailStep && emailStep.offsetParent !== null;
      box.hidden = !(stripeReady || (themed && !asking));
      document.body.classList.toggle('dm-has-pay', !box.hidden);
    }, 600);

    function send(mode) {
      full.disabled = part.disabled = true;
      post('/api/demo/simulate/' + encodeURIComponent(id) + '?t=' + encodeURIComponent(token), { mode: mode })
        .then(function (d) {
          if (!d._ok) {
            note.textContent = d.detail || tr('Could not send.');
            full.disabled = part.disabled = false;
            return;
          }
          note.textContent = mode === 'half' ? tr('Half sent. Waiting for the rest.') : tr('Sent. Confirming…');
          full.disabled = part.disabled = mode !== 'half';
        }).catch(function () { full.disabled = part.disabled = false; });
    }
    full.addEventListener('click', function () { send('full'); });
    part.addEventListener('click', function () { send('half'); });

    var tries = 0;
    function showResult(r) {
      clearInterval(watch);
      row.remove();
      box.hidden = false;
      document.body.classList.add('dm-has-pay');
      note.className = 'dm-note dm-result';
      note.textContent = '';
      var line = el('span', '', '');
      if (!r.configured) {
        line.textContent = tr('Paid. No webhook set.') + ' ';
        var a = el('a', 'dm-link', tr('Add one'));
        a.href = '/dashboard#api';
        line.appendChild(a);
      } else if (!r.delivery) {
        line.textContent = tr('Paid. Sending to your webhook…');
      } else if (r.delivery.ok) {
        line.textContent = tr('Paid. Sent to your webhook') + ' · ' + r.delivery.status_code;
      } else {
        line.className = 'dm-bad';
        line.textContent = tr('Paid. Webhook failed') + ' · ' + (r.delivery.status_code || r.delivery.error || '');
      }
      note.appendChild(line);
    }

    var poll = setInterval(function () {
      fetch('/api/demo/webhook-result/' + encodeURIComponent(id) + '?t=' + encodeURIComponent(token), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d) return;
          if (d.status === 'expired' || d.status === 'cancelled') {
            clearInterval(poll); clearInterval(watch);
            box.remove();
            document.body.classList.remove('dm-has-pay');
            return;
          }
          if (d.status !== 'confirmed') return;
          showResult(d);
          tries++;
          if (!d.configured || d.delivery || tries > 6) clearInterval(poll);
        }).catch(function () {});
    }, 2500);
  }

  function webhookLog() {
    var input = document.getElementById('webhook-url');
    var card = input && input.closest('.card');
    if (!card || card.querySelector('.dm-log')) return;
    var wrap = el('div', 'dm-log');
    var head = el('div', 'dm-log-head');
    head.appendChild(el('b', '', tr('Recent deliveries')));
    var refresh = el('button', 'dm-end', tr('Refresh'));
    refresh.type = 'button';
    head.appendChild(refresh);
    wrap.appendChild(head);
    var list = el('div', 'dm-log-list');
    wrap.appendChild(list);
    card.appendChild(wrap);

    function ago(iso) {
      var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
      if (s < 60) return s + 's';
      if (s < 3600) return Math.round(s / 60) + 'm';
      return Math.round(s / 3600) + 'h';
    }

    function load() {
      fetch('/api/demo/webhooks', { credentials: 'include', cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d) return;
          list.textContent = '';
          if (!d.deliveries.length) {
            list.appendChild(el('div', 'dm-empty', d.configured ? tr('Nothing sent yet. Pay a checkout to see it here.') : tr('Save an endpoint, then pay a checkout.')));
            return;
          }
          d.deliveries.forEach(function (x) {
            var item = el('details', 'dm-log-item');
            var sum = el('summary', '');
            sum.appendChild(el('span', 'dm-code ' + (x.ok ? 'ok' : 'bad'), x.status_code ? String(x.status_code) : '—'));
            sum.appendChild(el('span', 'dm-ev', x.event));
            sum.appendChild(el('span', 'dm-ago', ago(x.created_at)));
            item.appendChild(sum);
            if (x.error) item.appendChild(el('div', 'dm-err', x.error));
            var pre = el('pre', 'dm-pre');
            try { pre.textContent = JSON.stringify(JSON.parse(x.payload), null, 2); } catch (e) { pre.textContent = x.payload || ''; }
            item.appendChild(pre);
            list.appendChild(item);
          });
        }).catch(function () {});
    }
    refresh.addEventListener('click', load);
    load();
    setInterval(function () { if (card.offsetParent !== null && !list.querySelector('details[open]')) load(); }, 6000);
  }

  function start() {
    if (path === '/dashboard' || path.indexOf('/dashboard/') === 0) dashboard();
    else if (path.indexOf('/invoice/') === 0) checkout();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
