/* ============================================
   VERDICT — App JS
   Three.js 3D hero, scroll animations, counters,
   FAQ, nav scroll, cursor glow, mobile menu
   ============================================ */

// ---- THREE.JS HERO PARTICLE SYSTEM ----
(function initHero3D() {
  const canvas = document.getElementById('heroCanvas');
  if (!canvas) return;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  camera.position.z = 5;

  // Particle system — probability surface
  const PARTICLE_COUNT = 3000;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const colors = new Float32Array(PARTICLE_COUNT * 3);
  const sizes = new Float32Array(PARTICLE_COUNT);
  const velocities = new Float32Array(PARTICLE_COUNT * 3);

  // glacier palette — matches the landing splash
  const accentColor = new THREE.Color(0x7BA9D9); // glacier blue
  const purpleColor = new THREE.Color(0xA8C5E0); // pale ice
  const greenColor  = new THREE.Color(0xEAF0F5); // snow white

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const i3 = i * 3;
    positions[i3] = (Math.random() - 0.5) * 12;
    positions[i3 + 1] = (Math.random() - 0.5) * 8;
    positions[i3 + 2] = (Math.random() - 0.5) * 6;

    velocities[i3] = (Math.random() - 0.5) * 0.002;
    velocities[i3 + 1] = (Math.random() - 0.5) * 0.002;
    velocities[i3 + 2] = (Math.random() - 0.5) * 0.001;

    const colorChoice = Math.random();
    let color;
    if (colorChoice < 0.5) color = accentColor;
    else if (colorChoice < 0.8) color = purpleColor;
    else color = greenColor;

    colors[i3] = color.r;
    colors[i3 + 1] = color.g;
    colors[i3 + 2] = color.b;

    sizes[i] = Math.random() * 3 + 0.5;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  const vertexShader = `
    attribute float size;
    varying vec3 vColor;
    void main() {
      vColor = color;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = size * (300.0 / -mvPosition.z);
      gl_Position = projectionMatrix * mvPosition;
    }
  `;

  const fragmentShader = `
    varying vec3 vColor;
    void main() {
      float dist = length(gl_PointCoord - vec2(0.5));
      if (dist > 0.5) discard;
      float alpha = 1.0 - smoothstep(0.2, 0.5, dist);
      gl_FragColor = vec4(vColor, alpha * 0.35);
    }
  `;

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    vertexColors: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const particles = new THREE.Points(geometry, material);
  scene.add(particles);

  // Connection lines between nearby particles
  const lineGeometry = new THREE.BufferGeometry();
  const MAX_LINES = 600;
  const linePositions = new Float32Array(MAX_LINES * 6);
  lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));

  const lineMaterial = new THREE.LineBasicMaterial({
    color: 0x7BA9D9,
    transparent: true,
    opacity: 0.06,
    blending: THREE.AdditiveBlending,
  });

  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  scene.add(lines);

  let mouseX = 0, mouseY = 0;
  let time = 0;

  function updateLines() {
    const pos = geometry.attributes.position.array;
    let lineIdx = 0;
    const threshold = 1.2;

    for (let i = 0; i < Math.min(PARTICLE_COUNT, 200) && lineIdx < MAX_LINES; i++) {
      for (let j = i + 1; j < Math.min(PARTICLE_COUNT, 200) && lineIdx < MAX_LINES; j++) {
        const dx = pos[i * 3] - pos[j * 3];
        const dy = pos[i * 3 + 1] - pos[j * 3 + 1];
        const dz = pos[i * 3 + 2] - pos[j * 3 + 2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (dist < threshold) {
          const li = lineIdx * 6;
          linePositions[li] = pos[i * 3];
          linePositions[li + 1] = pos[i * 3 + 1];
          linePositions[li + 2] = pos[i * 3 + 2];
          linePositions[li + 3] = pos[j * 3];
          linePositions[li + 4] = pos[j * 3 + 1];
          linePositions[li + 5] = pos[j * 3 + 2];
          lineIdx++;
        }
      }
    }

    for (let i = lineIdx * 6; i < MAX_LINES * 6; i++) {
      linePositions[i] = 0;
    }

    lineGeometry.attributes.position.needsUpdate = true;
  }

  function animate() {
    requestAnimationFrame(animate);
    time += 0.001;

    const pos = geometry.attributes.position.array;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const i3 = i * 3;
      pos[i3] += velocities[i3] + Math.sin(time + i * 0.01) * 0.001;
      pos[i3 + 1] += velocities[i3 + 1] + Math.cos(time + i * 0.01) * 0.001;
      pos[i3 + 2] += velocities[i3 + 2];

      // Wrap around
      if (pos[i3] > 6) pos[i3] = -6;
      if (pos[i3] < -6) pos[i3] = 6;
      if (pos[i3 + 1] > 4) pos[i3 + 1] = -4;
      if (pos[i3 + 1] < -4) pos[i3 + 1] = 4;
      if (pos[i3 + 2] > 3) pos[i3 + 2] = -3;
      if (pos[i3 + 2] < -3) pos[i3 + 2] = 3;
    }

    geometry.attributes.position.needsUpdate = true;

    // Subtle mouse follow
    particles.rotation.y += (mouseX * 0.0002 - particles.rotation.y * 0.1) * 0.05;
    particles.rotation.x += (mouseY * 0.0001 - particles.rotation.x * 0.1) * 0.05;

    // Slow base rotation
    particles.rotation.y += 0.0003;
    particles.rotation.x += 0.0001;

    lines.rotation.copy(particles.rotation);

    if (Math.floor(time * 100) % 5 === 0) {
      updateLines();
    }

    renderer.render(scene, camera);
  }

  animate();

  window.addEventListener('mousemove', (e) => {
    mouseX = (e.clientX - window.innerWidth / 2);
    mouseY = (e.clientY - window.innerHeight / 2);
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
})();


// ---- NAV SCROLL ----
(function initNav() {
  const nav = document.getElementById('nav');
  let lastScroll = 0;

  window.addEventListener('scroll', () => {
    const scroll = window.scrollY;
    if (scroll > 50) {
      nav.classList.add('scrolled');
    } else {
      nav.classList.remove('scrolled');
    }
    lastScroll = scroll;
  });
})();


// ---- MOBILE MENU ----
(function initMobileMenu() {
  const toggle = document.getElementById('mobileToggle');
  const menu = document.getElementById('mobileMenu');
  if (!toggle || !menu) return;

  toggle.addEventListener('click', () => {
    menu.classList.toggle('open');
    toggle.classList.toggle('active');
  });

  menu.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      menu.classList.remove('open');
      toggle.classList.remove('active');
    });
  });
})();


// ---- SCROLL REVEAL ----
(function initScrollReveal() {
  const elements = document.querySelectorAll(
    '.step-card, .feature-card, .rule-card, .pricing-card, .market-card, .founder-card, .faq-item, .section-header, .proof-split, .comparison-table-wrap, .leaderboard-table-wrap, .addons-section, .cta-content'
  );

  elements.forEach(el => el.classList.add('scroll-reveal'));

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry, i) => {
      if (entry.isIntersecting) {
        const delay = Array.from(entry.target.parentElement.children).indexOf(entry.target) * 80;
        setTimeout(() => {
          entry.target.classList.add('visible');
        }, Math.min(delay, 400));
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

  elements.forEach(el => observer.observe(el));

  // Fallback: reveal all after 2s in case observer doesn't fire (headless/iframe environments)
  setTimeout(() => {
    elements.forEach(el => el.classList.add('visible'));
  }, 2000);
})();


// ---- COUNTER ANIMATION ----
(function initCounters() {
  const counters = document.querySelectorAll('.stat-number');

  const formatNumber = (num, prefix, suffix) => {
    prefix = prefix || '';
    suffix = suffix || '';
    if (num >= 1000000) return prefix + (num / 1000000).toFixed(1) + 'M' + suffix;
    if (num >= 1000) return prefix + (num / 1000).toFixed(num >= 10000 ? 0 : 1) + 'K' + suffix;
    return prefix + Math.round(num).toLocaleString() + suffix;
  };

  const animateCounter = (el) => {
    const target = parseInt(el.dataset.target);
    const prefix = el.dataset.prefix || '';
    const suffix = el.dataset.suffix || '';
    const duration = 2000;
    const start = performance.now();

    const tick = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(target * eased);
      el.textContent = formatNumber(current, prefix, suffix);
      if (progress < 1) requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        animateCounter(entry.target);
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.5 });

  counters.forEach(c => observer.observe(c));
})();


// ---- FAQ ----
(function initFAQ() {
  document.querySelectorAll('.faq-question').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      const wasOpen = item.classList.contains('open');

      // Close all
      document.querySelectorAll('.faq-item.open').forEach(i => i.classList.remove('open'));

      // Toggle clicked
      if (!wasOpen) item.classList.add('open');
    });
  });
})();


// ---- CURSOR GLOW ----
(function initCursorGlow() {
  if (window.matchMedia('(hover: none)').matches) return;

  const glow = document.createElement('div');
  glow.className = 'glow-cursor';
  document.body.appendChild(glow);

  let curX = 0, curY = 0;
  let glowX = 0, glowY = 0;

  document.addEventListener('mousemove', (e) => {
    curX = e.clientX;
    curY = e.clientY;
  });

  function animateGlow() {
    glowX += (curX - glowX) * 0.08;
    glowY += (curY - glowY) * 0.08;
    glow.style.left = glowX + 'px';
    glow.style.top = glowY + 'px';
    requestAnimationFrame(animateGlow);
  }

  animateGlow();
})();


// ---- SMOOTH ANCHOR SCROLLS ----
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', (e) => {
    const target = document.querySelector(a.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});
