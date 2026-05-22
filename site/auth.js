/* ============================================
   VERDICT — Auth client logic (sign-in + sign-up)
   ---------------------------------------------
   Client-side only (no backend yet). Validates,
   stores a fake session token in localStorage,
   then redirects to index.html#dashboard.
   When the backend is live, replace `fakeApi`
   with real fetch() calls.
   ============================================ */
(function(){

  // ------------- helpers -------------
  const $  = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

  function showError(input, msg) {
    input.classList.add('has-error');
    const err = input.closest('.field')?.querySelector('.field-error');
    if (err) { err.textContent = msg; err.classList.add('show'); }
  }
  function clearError(input) {
    input.classList.remove('has-error');
    const err = input.closest('.field')?.querySelector('.field-error');
    if (err) { err.classList.remove('show'); err.textContent = ''; }
  }
  function emailValid(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v || '').trim());
  }
  function passwordScore(v) {
    let s = 0;
    if (!v) return 0;
    if (v.length >= 8) s++;
    if (v.length >= 12) s++;
    if (/[A-Z]/.test(v) && /[a-z]/.test(v)) s++;
    if (/\d/.test(v)) s++;
    if (/[^A-Za-z0-9]/.test(v)) s++;
    return Math.min(s, 4);
  }
  function toast(msg, kind='ok') {
    let t = $('.toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.remove('err', 'ok'); t.classList.add(kind);
    requestAnimationFrame(() => t.classList.add('show'));
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 3400);
  }

  // ------------- real API (hits server.js) -------------
  async function apiCall(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  const fakeApi = {  // kept name; now real
    signIn(email, password) {
      if (!emailValid(email)) return Promise.reject('Invalid email');
      if (!password || password.length < 8) return Promise.reject('Password too short');
      return apiCall('/api/signin', { email, password });
    },
    signUp(payload) {
      if (!payload.fullName || payload.fullName.length < 2) return Promise.reject('Full name required');
      if (!emailValid(payload.email)) return Promise.reject('Invalid email');
      if (passwordScore(payload.password) < 3) return Promise.reject('Choose a stronger password');
      if (payload.password !== payload.confirm) return Promise.reject("Passwords don't match");
      if (!payload.agreedTerms || !payload.agreedRisk) return Promise.reject('You must accept both agreements');
      // read URL params to know the chosen plan
      const qs = new URLSearchParams(location.search);
      return apiCall('/api/signup', {
        email:      payload.email,
        password:   payload.password,
        full_name:  payload.fullName,
        plan:       qs.get('plan') || 'pro',
        size:       Number(qs.get('size')) || 50000,
      });
    },
    googleOAuth() {
      // stub until you wire real OAuth — auto-creates a demo account on the backend
      const demo = 'demo+' + Math.random().toString(36).slice(2,8) + '@verdict.markets';
      return apiCall('/api/signup', {
        email: demo,
        password: 'GoogleStub123!',
        full_name: 'Demo Trader',
        plan: 'pro', size: 50000,
      });
    },
  };

  function setSession({ token, user }) {
    try {
      localStorage.setItem('verdict_token', token);
      localStorage.setItem('verdict_user', JSON.stringify(user));
    } catch(e) {}
  }

  // ------------- password reveal toggles -------------
  $$('.field-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const input = btn.parentElement.querySelector('input');
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
      btn.dataset.shown = input.type === 'text' ? '1' : '0';
    });
  });

  // ------------- password strength meter -------------
  const pwInput = $('#pwInput');
  if (pwInput) {
    const bars  = $$('.pw-strength-bar');
    const label = $('.pw-strength-label');
    pwInput.addEventListener('input', () => {
      const s = passwordScore(pwInput.value);
      bars.forEach((b, i) => {
        b.classList.remove('on-weak','on-fair','on-good','on-strong');
        if (i < s) {
          if (s === 1) b.classList.add('on-weak');
          else if (s === 2) b.classList.add('on-fair');
          else if (s === 3) b.classList.add('on-good');
          else b.classList.add('on-strong');
        }
      });
      if (label) {
        label.textContent = ['Too weak','Weak','Fair','Strong','Very strong'][s] || 'Too weak';
      }
    });
  }

  // ------------- sign-in -------------
  const signinForm = $('#signinForm');
  if (signinForm) {
    signinForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email    = $('#siEmail').value.trim();
      const password = $('#siPassword').value;
      [...signinForm.querySelectorAll('.field-input')].forEach(clearError);

      let valid = true;
      if (!emailValid(email)) { showError($('#siEmail'), 'Enter a valid email'); valid = false; }
      if (!password || password.length < 8) { showError($('#siPassword'), 'At least 8 characters'); valid = false; }
      if (!valid) return;

      const btn = $('#signinBtn');
      btn.classList.add('is-loading');
      try {
        const res = await fakeApi.signIn(email, password);
        setSession(res);
        toast('Welcome back. Redirecting…', 'ok');
        setTimeout(() => { window.location.href = 'trade.html'; }, 700);
      } catch (err) {
        btn.classList.remove('is-loading');
        toast(err.toString(), 'err');
      }
    });
  }

  // ------------- sign-up -------------
  const signupForm = $('#signupForm');
  if (signupForm) {
    signupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        fullName:     $('#suName').value.trim(),
        email:        $('#suEmail').value.trim(),
        password:     $('#suPassword').value,
        confirm:      $('#suConfirm').value,
        agreedTerms:  $('#agreeTerms').checked,
        agreedRisk:   $('#agreeRisk').checked,
      };
      [...signupForm.querySelectorAll('.field-input')].forEach(clearError);

      let valid = true;
      if (!payload.fullName || payload.fullName.length < 2) { showError($('#suName'), 'Enter your full name'); valid = false; }
      if (!emailValid(payload.email)) { showError($('#suEmail'), 'Enter a valid email'); valid = false; }
      if (passwordScore(payload.password) < 3) { showError($('#suPassword'), 'Make it longer or add a number / symbol'); valid = false; }
      if (payload.password !== payload.confirm) { showError($('#suConfirm'), 'Passwords don\'t match'); valid = false; }
      if (!payload.agreedTerms || !payload.agreedRisk) {
        toast('Please accept both agreements', 'err');
        valid = false;
      }
      if (!valid) return;

      const btn = $('#signupBtn');
      btn.classList.add('is-loading');
      try {
        const res = await fakeApi.signUp(payload);
        setSession(res);
        toast('Account created. Loading your eval…', 'ok');
        // Preserve plan params from signup URL so trade.html can show checkout
        const qs = new URLSearchParams(location.search);
        const plan = qs.get('plan');
        const tradeUrl = plan ? `trade.html?plan=${plan}&size=${qs.get('size') || ''}&purchase=1` : 'trade.html';
        setTimeout(() => { window.location.href = tradeUrl; }, 800);
      } catch (err) {
        btn.classList.remove('is-loading');
        toast(err.toString(), 'err');
      }
    });
  }

  // ------------- Google -------------
  $$('.oauth-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const original = btn.innerHTML;
      btn.innerHTML = '<span style="opacity:.8">Connecting to Google…</span>';
      try {
        const res = await fakeApi.googleOAuth();
        setSession(res);
        toast('Signed in via Google', 'ok');
        setTimeout(() => { window.location.href = 'trade.html'; }, 600);
      } catch(err) {
        btn.innerHTML = original;
        toast('Google sign-in failed', 'err');
      }
    });
  });

  // ------------- chart mock (right rail) -------------
  const chartHost = $('#dmChart');
  if (chartHost) {
    const w = chartHost.clientWidth || 480;
    const h = chartHost.clientHeight || 130;
    const pts = 40;
    let v = 60, points = [];
    for (let i = 0; i < pts; i++) {
      v += (Math.random() - 0.45) * 8;
      v = Math.max(20, Math.min(110, v));
      points.push(v);
    }
    points = points.map((p, i) => [ (i / (pts - 1)) * w, h - (p / 130) * h ]);
    const linePath = 'M' + points.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L');
    const areaPath = linePath + ` L${w},${h} L0,${h} Z`;
    chartHost.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="dmFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"  stop-color="#7BA9D9" stop-opacity="0.4"/>
            <stop offset="100%" stop-color="#7BA9D9" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${areaPath}" fill="url(#dmFill)"/>
        <path d="${linePath}" stroke="#7BA9D9" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }
})();
