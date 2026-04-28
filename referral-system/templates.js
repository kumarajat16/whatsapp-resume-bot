// Self-contained HTML strings for /referral landing page and /referral/dashboard.
// No external CDNs — all CSS/JS inline. Mobile-first. Uses string concat for any
// client-side URL/string building to avoid backtick escaping headaches.

const SHARED_HEAD_STYLES = `
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f7fa;color:#1a1f36;line-height:1.5;overflow-x:hidden}
body{min-height:100vh;position:relative}
.bg-icons{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:0;opacity:0.04;overflow:hidden}
.bg-icons svg{position:absolute;width:80px;height:80px}
@media(min-width:768px){.bg-icons svg{width:120px;height:120px}}
.container{position:relative;z-index:1;max-width:560px;margin:0 auto;padding:24px 20px 40px}
@media(min-width:768px){.container{max-width:720px;padding:32px 24px 48px}}
button{font-family:inherit;cursor:pointer;border:none;font-size:15px;font-weight:600;transition:all 0.2s}
button:active{transform:scale(0.98)}
input{font-family:inherit;font-size:16px;outline:none}
.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%) translateY(-100px);background:#1a1f36;color:white;padding:12px 20px;border-radius:8px;font-size:14px;z-index:1000;transition:transform 0.3s;box-shadow:0 4px 12px rgba(0,0,0,0.2)}
.toast.show{transform:translateX(-50%) translateY(0)}
.toast.error{background:#dc2626}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,180,0,0.5)}50%{box-shadow:0 0 0 12px rgba(255,180,0,0)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
@keyframes shimmer{0%{background-position:-400px 0}100%{background-position:400px 0}}
`;

const BG_ICONS_SVG = `
<div class="bg-icons" aria-hidden="true">
<svg style="top:5%;left:8%" viewBox="0 0 24 24" fill="none" stroke="#1F3864" stroke-width="1.5"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>
<svg style="top:18%;right:6%;animation:float 6s ease-in-out infinite" viewBox="0 0 24 24" fill="none" stroke="#1F3864" stroke-width="1.5"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>
<svg style="top:38%;left:4%;animation:float 7s ease-in-out infinite" viewBox="0 0 24 24" fill="none" stroke="#1F3864" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>
<svg style="top:55%;right:10%" viewBox="0 0 24 24" fill="none" stroke="#1F3864" stroke-width="1.5"><rect x="4" y="6" width="16" height="14" rx="2"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M12 11v3"/><path d="M9 13h6"/></svg>
<svg style="top:72%;left:9%;animation:float 8s ease-in-out infinite" viewBox="0 0 24 24" fill="none" stroke="#1F3864" stroke-width="1.5"><path d="M12 2a4 4 0 0 1 4 4v2H8V6a4 4 0 0 1 4-4z"/><rect x="6" y="8" width="12" height="12" rx="2"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/></svg>
<svg style="top:88%;right:14%" viewBox="0 0 24 24" fill="none" stroke="#1F3864" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
</div>
`;

const TIP_CARDS_DATA = [
  { emoji: '🎙️', text: 'Create your resume by speaking — any language works' },
  { emoji: '⚡', text: 'Most users finish their resume in under 5 minutes' },
  { emoji: '🍿', text: '₹49 = evening snacks. Your resume lasts years.' },
  { emoji: '📈', text: '400+ resumes created daily on ResumeWala' },
];

const TESTIMONIALS_DATA = [
  { text: 'Got my first interview using ResumeWala!', author: 'Priya, Bangalore' },
  { text: 'Amazing tool for freshers. Finished in 4 minutes.', author: 'Rahul, Pune' },
  { text: 'Voice note feature was a lifesaver — I could just talk.', author: 'Anjali, Delhi' },
  { text: 'Cleaner than anything I made on my own. Worth every rupee.', author: 'Karan, Mumbai' },
];

const FAQ_DATA = [
  {
    q: 'What is ResumeWala?',
    a: 'ResumeWala is an AI-powered resume builder on WhatsApp. Tell us about yourself in chat or voice, and we craft a professional, ATS-friendly resume in minutes.',
  },
  {
    q: 'How does the referral program work?',
    a: 'Sign up with your phone number to get a unique referral link. Share it with friends. When they create a resume using your link, you earn rewards based on milestones — every 5 referrals = ₹50 extra, with a special ₹500 bumper at your 51st referral.',
  },
  {
    q: 'When will I get paid?',
    a: 'Once you hit a reward milestone, our team will reach out on WhatsApp to process your payout. Make sure your phone number is active.',
  },
  {
    q: 'Is there a limit on rewards?',
    a: 'Maximum reward is ₹1000 — that\'s ₹500 from regular milestones (50 referrals × ₹50 every 5) plus a ₹500 bumper bonus when you hit your 51st referral.',
  },
  {
    q: 'Can I refer the same person twice?',
    a: 'No. Each referred friend counts only once, and only after they successfully create a resume.',
  },
];

function buildLadderHtml(activeCount, isDashboard) {
  let rows = '';
  for (let m = 1; m <= 10; m++) {
    const refsNeeded = m * 5;
    const reward = m * 50;
    const hit = isDashboard && activeCount >= refsNeeded;
    rows += '<div class="rung ' + (hit ? 'rung-hit' : '') + '">';
    rows += '<span class="rung-num">' + refsNeeded + '</span>';
    rows += '<span class="rung-label">referrals</span>';
    rows += '<span class="rung-arrow">→</span>';
    rows += '<span class="rung-reward">₹' + reward + '</span>';
    if (hit) rows += '<span class="rung-tick">✓</span>';
    rows += '</div>';
  }
  const bumperHit = isDashboard && activeCount >= 51;
  rows += '<div class="rung rung-bumper ' + (bumperHit ? 'rung-hit' : '') + '">';
  rows += '<span class="rung-num">51</span>';
  rows += '<span class="rung-label">BUMPER</span>';
  rows += '<span class="rung-arrow">→</span>';
  rows += '<span class="rung-reward">₹500</span>';
  if (bumperHit) rows += '<span class="rung-tick">✓</span>';
  rows += '</div>';
  return rows;
}

// ─── LANDING PAGE ───────────────────────────────────────────────────────────

const LANDING_HTML = '<!DOCTYPE html><html lang="en"><head>' +
  '<meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>ResumeWala Referral — Earn up to ₹1000</title>' +
  '<style>' + SHARED_HEAD_STYLES + `
.hero{text-align:center;padding:24px 0 16px;animation:fadeUp 0.6s ease-out}
.hero-badge{display:inline-block;background:#FFF4D6;color:#A8741A;padding:6px 14px;border-radius:20px;font-size:12px;font-weight:700;letter-spacing:0.3px;margin-bottom:14px;text-transform:uppercase}
.hero h1{color:#1F3864;font-size:26px;line-height:1.25;font-weight:800;margin-bottom:12px;letter-spacing:-0.3px}
.hero h1 .gold{color:#D88A00;background:linear-gradient(90deg,#D88A00,#FFB400);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
@media(min-width:768px){.hero h1{font-size:36px}}
.hero p{color:#5b6478;font-size:15px;max-width:480px;margin:0 auto}
.tip-row{display:flex;gap:10px;overflow-x:auto;padding:18px 4px 6px;margin:0 -4px;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch}
.tip-row::-webkit-scrollbar{display:none}
.tip{flex:0 0 200px;background:white;border-radius:14px;padding:14px;box-shadow:0 2px 8px rgba(31,56,100,0.06);border:1px solid rgba(31,56,100,0.06);scroll-snap-align:start;animation:float 5s ease-in-out infinite}
.tip:nth-child(2){animation-delay:0.5s}
.tip:nth-child(3){animation-delay:1s}
.tip:nth-child(4){animation-delay:1.5s}
.tip-emoji{font-size:22px;margin-bottom:6px}
.tip-text{font-size:13px;color:#3a4258;line-height:1.4;font-weight:500}
.card{background:white;border-radius:16px;padding:24px 20px;box-shadow:0 4px 16px rgba(31,56,100,0.08);border:1px solid rgba(31,56,100,0.05);margin:16px 0;animation:fadeUp 0.6s ease-out}
.card h2{font-size:18px;color:#1F3864;margin-bottom:16px;font-weight:700}
.input-group{margin-bottom:14px}
.input-group label{display:block;font-size:12px;color:#6b7280;font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.3px}
.input-group input{width:100%;padding:13px 14px;border:1.5px solid #e2e8f0;border-radius:10px;background:#f8fafc;transition:all 0.2s}
.input-group input:focus{border-color:#1F3864;background:white;box-shadow:0 0 0 3px rgba(31,56,100,0.08)}
.phone-wrap{display:flex;align-items:stretch;border:1.5px solid #e2e8f0;border-radius:10px;overflow:hidden;background:#f8fafc;transition:all 0.2s}
.phone-wrap:focus-within{border-color:#1F3864;background:white;box-shadow:0 0 0 3px rgba(31,56,100,0.08)}
.phone-prefix{padding:13px 14px;background:#eef2f7;color:#1F3864;font-weight:700;font-size:15px;border-right:1.5px solid #e2e8f0;user-select:none}
.phone-wrap input{flex:1;border:none;background:transparent;padding:13px 14px}
.btn-primary{width:100%;padding:14px;background:linear-gradient(135deg,#1F3864,#2D4F8E);color:white;border-radius:10px;font-size:16px;font-weight:700;letter-spacing:0.2px;box-shadow:0 4px 12px rgba(31,56,100,0.25)}
.btn-primary:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(31,56,100,0.35)}
.btn-primary:disabled{opacity:0.6;cursor:wait}
.help-text{font-size:12px;color:#9aa3b8;text-align:center;margin-top:10px}
.section-title{text-align:center;font-size:14px;color:#9aa3b8;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin:36px 0 16px}
.ladder-card{padding:20px 16px}
.ladder-card .total-banner{background:linear-gradient(135deg,#FFF4D6,#FFE9B0);color:#8B5A00;padding:12px 16px;border-radius:10px;text-align:center;font-weight:700;font-size:14px;margin-bottom:18px;border:1px solid rgba(255,180,0,0.3)}
.ladder-card .total-banner strong{color:#1F3864;font-size:18px}
.rung{display:grid;grid-template-columns:auto auto 1fr auto auto;gap:8px;align-items:center;padding:12px 14px;border-radius:10px;margin:6px 0;background:#f8fafc;transition:all 0.2s;font-size:14px}
.rung-num{font-weight:800;color:#1F3864;font-size:18px;min-width:32px}
.rung-label{font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;font-weight:600}
.rung-arrow{color:#9aa3b8;font-weight:700}
.rung-reward{color:#D88A00;font-weight:800;font-size:16px}
.rung-tick{color:#10b981;font-weight:900;font-size:18px}
.rung-bumper{background:linear-gradient(135deg,#FFF4D6,#FFE9B0);border:1.5px solid #FFB400;animation:pulse 2s infinite;margin-top:14px}
.rung-bumper .rung-label{color:#8B5A00;font-weight:800}
.rung-bumper .rung-reward{font-size:20px}
.steps{display:grid;gap:12px}
@media(min-width:600px){.steps{grid-template-columns:repeat(3,1fr)}}
.step{background:white;padding:18px 16px;border-radius:14px;text-align:center;box-shadow:0 2px 8px rgba(31,56,100,0.06);border:1px solid rgba(31,56,100,0.05)}
.step-num{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;background:#1F3864;color:white;font-weight:800;margin-bottom:10px;font-size:15px}
.step-title{font-weight:700;color:#1F3864;margin-bottom:4px;font-size:14px}
.step-desc{font-size:13px;color:#6b7280}
.testimonials{position:relative;min-height:130px}
.testimonial{background:white;padding:20px 18px;border-radius:14px;box-shadow:0 2px 8px rgba(31,56,100,0.06);border:1px solid rgba(31,56,100,0.05);position:absolute;inset:0;opacity:0;transition:opacity 0.5s;display:flex;flex-direction:column;justify-content:center}
.testimonial.active{opacity:1}
.testimonial-text{font-size:15px;color:#3a4258;font-style:italic;margin-bottom:8px;line-height:1.5}
.testimonial-author{font-size:13px;color:#9aa3b8;font-weight:600}
.dots{display:flex;gap:6px;justify-content:center;margin-top:14px}
.dot{width:8px;height:8px;border-radius:50%;background:#cbd5e1;transition:all 0.2s;cursor:pointer;border:none;padding:0}
.dot.active{background:#1F3864;width:20px;border-radius:4px}
.faq details{background:white;border-radius:12px;margin-bottom:8px;box-shadow:0 1px 4px rgba(31,56,100,0.05);border:1px solid rgba(31,56,100,0.05);overflow:hidden}
.faq summary{padding:16px 18px;font-weight:700;color:#1F3864;cursor:pointer;list-style:none;position:relative;padding-right:48px;font-size:14px}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:'+';position:absolute;right:18px;top:50%;transform:translateY(-50%);font-size:22px;color:#1F3864;font-weight:400;transition:transform 0.2s}
.faq details[open] summary::after{transform:translateY(-50%) rotate(45deg)}
.faq-body{padding:0 18px 16px;color:#5b6478;font-size:14px;line-height:1.6}
.footer{text-align:center;color:#9aa3b8;font-size:12px;padding:32px 0 16px}
.footer a{color:#1F3864;text-decoration:none}
` + '</style></head><body>' +
  BG_ICONS_SVG +
  '<div class="container">' +
    '<section class="hero">' +
      '<span class="hero-badge">🎁 Referral Rewards</span>' +
      '<h1>Earn <span class="gold">₹1000</span> with ResumeWala Referral Program</h1>' +
      '<p>Invite friends to create AI-powered resumes and earn rewards.</p>' +
    '</section>' +

    '<div class="tip-row">' +
      TIP_CARDS_DATA.map(t => '<div class="tip"><div class="tip-emoji">' + t.emoji + '</div><div class="tip-text">' + t.text + '</div></div>').join('') +
    '</div>' +

    '<section class="card">' +
      '<h2>Get Your Referral Link</h2>' +
      '<div class="input-group">' +
        '<label for="name">Your Name</label>' +
        '<input id="name" type="text" placeholder="Jayant Kumar" maxlength="60" autocomplete="name">' +
      '</div>' +
      '<div class="input-group">' +
        '<label for="phone">Phone Number</label>' +
        '<div class="phone-wrap">' +
          '<span class="phone-prefix">+91</span>' +
          '<input id="phone" type="tel" placeholder="98xxxxxxxx" maxlength="10" autocomplete="tel-national" inputmode="numeric">' +
        '</div>' +
      '</div>' +
      '<button class="btn-primary" id="loginBtn">Get My Referral Link →</button>' +
      '<div class="help-text">No OTP, no spam. Just your unique link.</div>' +
    '</section>' +

    '<div class="section-title">The Rewards Ladder</div>' +
    '<section class="card ladder-card">' +
      '<div class="total-banner">Earn up to <strong>₹1000</strong> in total<br><span style="font-size:12px;font-weight:600;opacity:0.85">10 milestones × ₹50 + ₹500 bumper bonus</span></div>' +
      buildLadderHtml(0, false) +
    '</section>' +

    '<div class="section-title">How it works</div>' +
    '<div class="steps">' +
      '<div class="step"><div class="step-num">1</div><div class="step-title">Sign Up</div><div class="step-desc">Quick name + phone, get your unique link</div></div>' +
      '<div class="step"><div class="step-num">2</div><div class="step-title">Share</div><div class="step-desc">Send to friends on WhatsApp, Instagram, anywhere</div></div>' +
      '<div class="step"><div class="step-num">3</div><div class="step-title">Earn</div><div class="step-desc">Cash rewards on every milestone unlocked</div></div>' +
    '</div>' +

    '<div class="section-title">What people say</div>' +
    '<div class="testimonials" id="testimonials">' +
      TESTIMONIALS_DATA.map((t, i) => '<div class="testimonial' + (i === 0 ? ' active' : '') + '"><div class="testimonial-text">"' + t.text + '"</div><div class="testimonial-author">— ' + t.author + '</div></div>').join('') +
    '</div>' +
    '<div class="dots" id="dots">' +
      TESTIMONIALS_DATA.map((_, i) => '<button class="dot' + (i === 0 ? ' active' : '') + '" data-i="' + i + '" aria-label="Testimonial ' + (i + 1) + '"></button>').join('') +
    '</div>' +

    '<div class="section-title">FAQ</div>' +
    '<section class="faq">' +
      FAQ_DATA.map(f => '<details><summary>' + f.q + '</summary><div class="faq-body">' + f.a + '</div></details>').join('') +
    '</section>' +

    '<div class="footer">Made with ❤️ by ResumeWala · <a href="/start">Build a Resume</a></div>' +
  '</div>' +

  '<div class="toast" id="toast"></div>' +

  '<script>' + `
(function(){
  var phone = document.getElementById('phone');
  phone.addEventListener('input', function(){ this.value = this.value.replace(/\\D/g,'').slice(0,10); });

  function showToast(msg, isErr){
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' error' : '');
    setTimeout(function(){ t.className = 'toast' + (isErr ? ' error' : ''); }, 2800);
  }

  // Auto-fill if returning user
  try {
    var saved = JSON.parse(localStorage.getItem('rw_referral') || 'null');
    if (saved && saved.phone_number) {
      window.location.href = '/referral/dashboard';
      return;
    }
  } catch(e){}

  document.getElementById('loginBtn').addEventListener('click', async function(){
    var btn = this;
    var name = document.getElementById('name').value.trim();
    var ph = phone.value.trim();
    if (!name) { showToast('Please enter your name', true); return; }
    if (ph.length !== 10) { showToast('Phone must be 10 digits', true); return; }
    btn.disabled = true;
    btn.textContent = 'Creating your link...';
    try {
      var r = await fetch('/referral/api/login', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ name: name, phone_number: ph })
      });
      var data = await r.json();
      if (!r.ok) { throw new Error(data.error || 'Login failed'); }
      localStorage.setItem('rw_referral', JSON.stringify({
        phone_number: data.phone_number,
        name: data.name,
        referral_id: data.referral_id
      }));
      window.location.href = '/referral/dashboard';
    } catch(err) {
      showToast(err.message || 'Something went wrong', true);
      btn.disabled = false;
      btn.textContent = 'Get My Referral Link →';
    }
  });

  // Testimonial rotator
  var idx = 0;
  var testimonials = document.querySelectorAll('.testimonial');
  var dots = document.querySelectorAll('.dot');
  function show(i){
    testimonials.forEach(function(el, j){ el.classList.toggle('active', i === j); });
    dots.forEach(function(el, j){ el.classList.toggle('active', i === j); });
    idx = i;
  }
  dots.forEach(function(d){ d.addEventListener('click', function(){ show(parseInt(this.dataset.i)); }); });
  setInterval(function(){ show((idx + 1) % testimonials.length); }, 4000);
})();
` + '</script></body></html>';

// ─── DASHBOARD PAGE ─────────────────────────────────────────────────────────

const DASH_STYLES = `
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,sans-serif;background:#fafafa;color:#0f172a;line-height:1.5;overflow-x:hidden;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{min-height:100vh;background:radial-gradient(1200px 600px at 50% -200px,rgba(99,102,241,0.06),transparent),linear-gradient(180deg,#fafafa 0%,#f4f4f5 100%);position:relative}
button{font-family:inherit;cursor:pointer;border:none;font-size:15px;font-weight:600;transition:all 0.2s ease;letter-spacing:-0.01em}
button:active{transform:scale(0.98)}
.container{position:relative;z-index:1;max-width:560px;margin:0 auto;padding:20px 16px 48px}
@media(min-width:768px){.container{max-width:640px;padding:32px 24px 64px}}

.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%) translateY(-100px);background:#0f172a;color:#fff;padding:12px 20px;border-radius:10px;font-size:14px;font-weight:500;z-index:1000;transition:transform 0.3s cubic-bezier(0.34,1.56,0.64,1);box-shadow:0 10px 40px -10px rgba(0,0,0,0.3)}
.toast.show{transform:translateX(-50%) translateY(0)}
.toast.error{background:#dc2626}

@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulseRing{0%{box-shadow:0 0 0 0 rgba(99,102,241,0.45)}70%{box-shadow:0 0 0 12px rgba(99,102,241,0)}100%{box-shadow:0 0 0 0 rgba(99,102,241,0)}}
@keyframes shimmer{0%{background-position:-400px 0}100%{background-position:400px 0}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes fall{0%{transform:translateY(0) rotate(0);opacity:1}100%{transform:translateY(110vh) rotate(720deg);opacity:0}}

/* Header */
.dash-header{display:flex;justify-content:space-between;align-items:flex-start;padding:4px 0 24px;animation:fadeUp 0.5s ease-out}
.h-greeting{font-size:24px;font-weight:800;color:#0f172a;letter-spacing:-0.02em;line-height:1.2}
.h-sub{font-size:14px;color:#64748b;margin-top:6px;font-weight:500}
.h-sub strong{color:#0f172a;font-weight:700}
.btn-link{background:transparent;color:#94a3b8;font-size:13px;padding:8px 12px;border-radius:8px;font-weight:500}
.btn-link:hover{color:#dc2626;background:#fef2f2}

/* Cards */
.card{background:#fff;border:1px solid rgba(15,23,42,0.06);border-radius:18px;padding:22px 20px;box-shadow:0 1px 2px rgba(15,23,42,0.04),0 4px 16px rgba(15,23,42,0.04);margin:14px 0}
@media(min-width:768px){.card{padding:26px 24px}}

/* Referral link card */
.link-card{animation:fadeUp 0.5s ease-out 0.1s both}
.lc-eyebrow{font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px}
.lc-link{display:block;background:linear-gradient(135deg,#f8fafc 0%,#f1f5f9 100%);border:1px solid rgba(15,23,42,0.06);border-radius:12px;padding:14px 16px;font-family:'SF Mono',ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#0f172a;word-break:break-all;margin-bottom:14px;font-weight:500;line-height:1.5}
.lc-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.btn-copy{background:#0f172a;color:#fff;padding:13px 14px;border-radius:11px;font-weight:600;font-size:14px;letter-spacing:-0.01em;display:flex;align-items:center;justify-content:center;gap:6px}
.btn-copy:hover{background:#1e293b;transform:translateY(-1px);box-shadow:0 6px 20px -6px rgba(15,23,42,0.4)}
.btn-copy.copied{background:#10b981}
.btn-share{background:#25D366;color:#fff;padding:13px 14px;border-radius:11px;font-weight:600;font-size:14px;letter-spacing:-0.01em;display:flex;align-items:center;justify-content:center;gap:6px}
.btn-share:hover{background:#1da851;transform:translateY(-1px);box-shadow:0 6px 20px -6px rgba(37,211,102,0.45)}

/* Carousel (features + tips) */
.carousel{position:relative;animation:fadeUp 0.5s ease-out 0.2s both;margin:14px 0}
.carousel-viewport{overflow:hidden;border-radius:18px}
.carousel-track{display:flex;transition:transform 0.45s cubic-bezier(0.4,0,0.2,1);will-change:transform}
.carousel-slide{flex:0 0 100%;min-width:0}
.feat-card{background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);color:#fff;border-radius:18px;padding:26px 22px;min-height:140px;display:flex;flex-direction:column;justify-content:center;position:relative;overflow:hidden}
.feat-card::after{content:'';position:absolute;right:-30px;top:-30px;width:140px;height:140px;background:radial-gradient(circle,rgba(99,102,241,0.25),transparent 70%);pointer-events:none}
.feat-icon{font-size:28px;margin-bottom:10px}
.feat-title{font-size:18px;font-weight:700;letter-spacing:-0.015em;line-height:1.3;color:#fff}
.feat-sub{font-size:13px;color:rgba(255,255,255,0.65);margin-top:6px;font-weight:500}
.tip-card{background:#fff;border:1px solid rgba(15,23,42,0.06);border-radius:18px;padding:22px 20px;min-height:120px;display:flex;align-items:center;gap:16px}
.tip-emoji{font-size:30px;flex-shrink:0}
.tip-text{font-size:14px;color:#334155;font-weight:500;line-height:1.5}
.carousel-dots{display:flex;gap:6px;justify-content:center;margin-top:14px}
.cdot{width:6px;height:6px;border-radius:50%;background:#cbd5e1;transition:all 0.3s;cursor:pointer;border:none;padding:0}
.cdot.active{background:#0f172a;width:22px;border-radius:3px}

/* Progress card */
.progress-card{animation:fadeUp 0.5s ease-out 0.3s both}
.p-eyebrow{font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px}
.p-headline{font-size:18px;font-weight:700;color:#0f172a;letter-spacing:-0.015em;line-height:1.3}
.p-headline strong{color:#4f46e5}
.p-sub{font-size:13px;color:#64748b;margin-top:6px;font-weight:500}
.p-bar-wrap{position:relative;height:10px;background:#f1f5f9;border-radius:999px;overflow:hidden;margin:18px 0 8px}
.p-fill{height:100%;background:linear-gradient(90deg,#6366f1 0%,#8b5cf6 100%);border-radius:999px;transition:width 1s cubic-bezier(0.4,0,0.2,1);position:relative}
.p-fill::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.35),transparent);background-size:400px 100%;animation:shimmer 2.5s infinite}
.p-bar-wrap.bumper .p-fill{background:linear-gradient(90deg,#f59e0b 0%,#f97316 100%)}
.p-meta{display:flex;justify-content:space-between;font-size:11px;color:#94a3b8;font-weight:600;letter-spacing:0.02em}

/* Reward ladder */
.ladder-card{animation:fadeUp 0.5s ease-out 0.4s both}
.lad-header{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px}
.lad-title{font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:0.08em}
.lad-total{font-size:12px;color:#475569;font-weight:600}
.lad-total strong{color:#0f172a;font-weight:800}
.lad-list{position:relative;padding:8px 0 0 36px;margin-top:18px}
.lad-list::before{content:'';position:absolute;left:13px;top:14px;bottom:14px;width:2px;background:linear-gradient(180deg,#e2e8f0 0%,#e2e8f0 100%);border-radius:2px}
.lad-row{position:relative;display:grid;grid-template-columns:1fr auto;align-items:center;gap:12px;padding:10px 0}
.lad-node{position:absolute;left:-29px;top:50%;transform:translateY(-50%);width:20px;height:20px;border-radius:50%;background:#fff;border:2px solid #e2e8f0;display:flex;align-items:center;justify-content:center;color:transparent;font-size:11px;font-weight:900;line-height:1;transition:all 0.3s}
.lad-row.hit .lad-node{background:linear-gradient(135deg,#10b981,#059669);border-color:transparent;color:#fff;box-shadow:0 0 0 4px rgba(16,185,129,0.12)}
.lad-row.current .lad-node{border-color:#6366f1;background:#fff;animation:pulseRing 2s infinite}
.lad-row.bumper .lad-node{background:#fff;border-color:#f59e0b}
.lad-row.bumper.hit .lad-node{background:linear-gradient(135deg,#f59e0b,#f97316);border-color:transparent;color:#fff;box-shadow:0 0 0 4px rgba(245,158,11,0.18)}
.lad-info{display:flex;align-items:baseline;gap:8px;min-width:0}
.lad-refs{font-size:14px;color:#0f172a;font-weight:600;letter-spacing:-0.01em}
.lad-row:not(.hit):not(.current) .lad-refs{color:#64748b;font-weight:500}
.lad-tag{font-size:10px;font-weight:800;letter-spacing:0.06em;padding:3px 7px;border-radius:5px;text-transform:uppercase;background:#fef3c7;color:#92400e}
.lad-row.bumper.hit .lad-tag{background:#fde68a;color:#78350f}
.lad-reward{font-size:14px;font-weight:700;color:#0f172a;font-variant-numeric:tabular-nums;letter-spacing:-0.01em}
.lad-row:not(.hit):not(.current) .lad-reward{color:#94a3b8}
.lad-row.bumper .lad-reward{color:#92400e}
.lad-row.bumper.hit .lad-reward{color:#78350f}

/* Section labels */
.section-eyebrow{display:flex;align-items:center;gap:10px;font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin:26px 4px 6px}
.section-eyebrow::before,.section-eyebrow::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,transparent,rgba(15,23,42,0.08),transparent)}

/* Loading */
.spinner-wrap{display:flex;justify-content:center;align-items:center;min-height:60vh;color:#94a3b8;font-size:14px;gap:10px}
.spinner{width:22px;height:22px;border:2.5px solid #e2e8f0;border-top-color:#6366f1;border-radius:50%;animation:spin 0.7s linear infinite}

/* Confetti */
.confetti{position:fixed;top:-10px;width:8px;height:14px;opacity:0;pointer-events:none;z-index:999;border-radius:1px}
`;

const DASHBOARD_HTML = '<!DOCTYPE html><html lang="en"><head>' +
  '<meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
  '<title>Your Referral Dashboard — ResumeWala</title>' +
  '<style>' + DASH_STYLES + '</style></head><body>' +
  '<div class="container">' +
    '<div id="content" class="spinner-wrap"><div class="spinner"></div>Loading your dashboard…</div>' +
  '</div>' +
  '<div class="toast" id="toast"></div>' +

  '<script>' + `
(function(){
  var saved;
  try { saved = JSON.parse(localStorage.getItem('rw_referral') || 'null'); } catch(e){}
  if (!saved || !saved.phone_number) { window.location.href = '/referral'; return; }

  function showToast(msg, isErr){
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' error' : '');
    setTimeout(function(){ t.className = 'toast' + (isErr ? ' error' : ''); }, 2400);
  }

  function escHtml(s){ return String(s||'').replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]); }); }

  function buildLadderHtml(count){
    var rows = '';
    var nextMilestone = -1;
    if (count < 50) nextMilestone = (Math.floor(count / 5) + 1) * 5;
    else if (count < 51) nextMilestone = 51;

    for (var m = 1; m <= 10; m++) {
      var refs = m * 5;
      var reward = m * 50;
      var hit = count >= refs;
      var isCurrent = !hit && refs === nextMilestone;
      var cls = 'lad-row' + (hit ? ' hit' : '') + (isCurrent ? ' current' : '');
      rows += '<div class="' + cls + '">';
      rows += '<div class="lad-node">' + (hit ? '✓' : '') + '</div>';
      rows += '<div class="lad-info"><span class="lad-refs">' + refs + ' referrals</span></div>';
      rows += '<div class="lad-reward">₹' + reward + '</div>';
      rows += '</div>';
    }
    var bumperHit = count >= 51;
    var bumperCurrent = !bumperHit && 51 === nextMilestone;
    var bcls = 'lad-row bumper' + (bumperHit ? ' hit' : '') + (bumperCurrent ? ' current' : '');
    rows += '<div class="' + bcls + '">';
    rows += '<div class="lad-node">' + (bumperHit ? '★' : '') + '</div>';
    rows += '<div class="lad-info"><span class="lad-refs">51 referrals</span><span class="lad-tag">Bonus</span></div>';
    rows += '<div class="lad-reward">₹500</div>';
    rows += '</div>';
    return rows;
  }

  function fireConfetti(){
    var colors = ['#6366f1','#8b5cf6','#10b981','#f59e0b','#ec4899','#0f172a'];
    for (var i = 0; i < 50; i++) {
      var d = document.createElement('div');
      d.className = 'confetti';
      d.style.left = Math.random() * 100 + 'vw';
      d.style.background = colors[i % colors.length];
      d.style.animation = 'fall ' + (1.8 + Math.random() * 1.6) + 's ease-in ' + (Math.random() * 0.5) + 's forwards';
      document.body.appendChild(d);
      setTimeout(function(el){ return function(){ el.remove(); }; }(d), 4500);
    }
  }

  function animateNumber(el, target){
    if (!el) return;
    var start = 0;
    var duration = 900;
    var t0 = performance.now();
    function tick(now){
      var p = Math.min((now - t0) / duration, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(start + (target - start) * eased);
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function setupCarousel(rootId, count, intervalMs){
    var root = document.getElementById(rootId);
    if (!root) return;
    var track = root.querySelector('.carousel-track');
    var dots = root.querySelectorAll('.cdot');
    var idx = 0;
    var timer = null;

    function go(i){
      idx = ((i % count) + count) % count;
      track.style.transform = 'translateX(-' + (idx * 100) + '%)';
      dots.forEach(function(el, j){ el.classList.toggle('active', j === idx); });
    }

    function start(){
      stop();
      timer = setInterval(function(){ go(idx + 1); }, intervalMs);
    }
    function stop(){ if (timer) { clearInterval(timer); timer = null; } }

    dots.forEach(function(el){
      el.addEventListener('click', function(){
        go(parseInt(this.dataset.i, 10));
        start();
      });
    });

    var startX = null;
    track.addEventListener('touchstart', function(e){ startX = e.touches[0].clientX; stop(); }, { passive: true });
    track.addEventListener('touchend', function(e){
      if (startX === null) return;
      var dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) > 40) go(idx + (dx < 0 ? 1 : -1));
      startX = null;
      start();
    });

    start();
  }

  async function load(){
    try {
      var r = await fetch('/referral/api/stats', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ phone_number: saved.phone_number })
      });
      if (r.status === 404) {
        localStorage.removeItem('rw_referral');
        window.location.href = '/referral';
        return;
      }
      var data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to load');
      render(data);
    } catch(err) {
      document.getElementById('content').className = '';
      document.getElementById('content').innerHTML = '<div style="text-align:center;padding:60px 20px;color:#dc2626">Could not load dashboard.<br><button onclick="location.reload()" style="background:#0f172a;color:#fff;padding:10px 18px;border-radius:10px;margin-top:14px;cursor:pointer;font-weight:600">Retry</button></div>';
    }
  }

  function render(d){
    var first = (saved.name || '').split(' ')[0] || 'there';
    var count = d.referral_count || 0;
    var nm = d.next_milestone;

    // Progress headline + bar (correctly handle 0 referrals and end-of-ladder)
    var headline, progressPct, isBumperBar = false;
    if (nm) {
      if (nm.kind === 'milestone') {
        headline = '<strong>' + nm.refs_away + '</strong> more ' + (nm.refs_away === 1 ? 'referral' : 'referrals') + ' to unlock <strong>₹' + nm.reward + '</strong>';
        var prevCount = nm.count - 5;
        progressPct = ((count - prevCount) / 5) * 100;
      } else {
        headline = '<strong>' + nm.refs_away + '</strong> more for the <strong>₹500 bonus</strong> 🎯';
        progressPct = ((count - 50) / 1) * 100;
        isBumperBar = true;
      }
    } else {
      headline = 'You\\'ve maxed out at <strong>₹1000</strong> — legend! 🏆';
      progressPct = 100;
    }
    if (count === 0) headline = 'Start sharing to unlock your first <strong>₹50</strong>';

    var html = '';

    // 1. HEADER
    html += '<header class="dash-header">';
    html += '<div>';
    html += '<div class="h-greeting">Welcome ' + escHtml(first) + ' 👋</div>';
    html += '<div class="h-sub">You have referred <strong>' + count + '</strong> ' + (count === 1 ? 'friend' : 'friends') + '</div>';
    html += '</div>';
    html += '<button class="btn-link" id="logoutBtn">Log out</button>';
    html += '</header>';

    // 2. REFERRAL LINK CARD
    html += '<section class="card link-card">';
    html += '<div class="lc-eyebrow">Your referral link</div>';
    html += '<div class="lc-link">' + escHtml(d.referral_link) + '</div>';
    html += '<div class="lc-actions">';
    html += '<button class="btn-copy" id="copyBtn"><span>Copy Link</span></button>';
    html += '<button class="btn-share" id="shareBtn"><span>Share on WhatsApp</span></button>';
    html += '</div></section>';

    // 3. FEATURES CAROUSEL (placed right after link, per spec)
    html += '<div class="carousel" id="featCarousel">';
    html += '<div class="carousel-viewport"><div class="carousel-track">';
    var feats = [
      { icon: '🎙️', title: 'Create your resume by speaking', sub: 'Voice notes in any language work' },
      { icon: '⚡', title: 'Most users finish in under 5 minutes', sub: 'Faster than ordering chai' },
      { icon: '🍿', title: '₹49 — cheaper than evening snacks', sub: 'And the resume lasts years' }
    ];
    feats.forEach(function(f){
      html += '<div class="carousel-slide"><div class="feat-card">';
      html += '<div class="feat-icon">' + f.icon + '</div>';
      html += '<div class="feat-title">' + f.title + '</div>';
      html += '<div class="feat-sub">' + f.sub + '</div>';
      html += '</div></div>';
    });
    html += '</div></div>';
    html += '<div class="carousel-dots">';
    for (var fi = 0; fi < feats.length; fi++) {
      html += '<button class="cdot' + (fi === 0 ? ' active' : '') + '" data-i="' + fi + '" aria-label="Slide ' + (fi+1) + '"></button>';
    }
    html += '</div></div>';

    // 4. PROGRESS CARD
    html += '<section class="card progress-card">';
    html += '<div class="p-eyebrow">Progress</div>';
    html += '<div class="p-headline">' + headline + '</div>';
    html += '<div class="p-sub">' + count + ' / ' + (nm ? nm.count : 51) + ' referrals</div>';
    html += '<div class="p-bar-wrap' + (isBumperBar ? ' bumper' : '') + '"><div class="p-fill" id="progressFill" style="width:0%"></div></div>';
    html += '<div class="p-meta"><span>0</span><span>Up to ₹' + d.max_possible + '</span></div>';
    html += '</section>';

    // 5. REWARD LADDER
    html += '<section class="card ladder-card">';
    html += '<div class="lad-header">';
    html += '<div class="lad-title">Reward Ladder</div>';
    html += '<div class="lad-total"><strong>₹' + d.amount_earned + '</strong> earned</div>';
    html += '</div>';
    html += '<div class="lad-list">' + buildLadderHtml(count) + '</div>';
    html += '</section>';

    // 6. TIPS CAROUSEL (bottom)
    html += '<div class="section-eyebrow">Tips to share more</div>';
    html += '<div class="carousel" id="tipCarousel">';
    html += '<div class="carousel-viewport"><div class="carousel-track">';
    var tips = [
      { emoji: '💬', text: 'Drop your link in college / office WhatsApp groups' },
      { emoji: '🎯', text: 'DM friends actively job hunting — they\\'ll thank you' },
      { emoji: '📸', text: 'Share on your Instagram story for a quick boost' },
      { emoji: '💼', text: 'Post on LinkedIn — every comment is free reach' }
    ];
    tips.forEach(function(t){
      html += '<div class="carousel-slide"><div class="tip-card">';
      html += '<div class="tip-emoji">' + t.emoji + '</div>';
      html += '<div class="tip-text">' + t.text + '</div>';
      html += '</div></div>';
    });
    html += '</div></div>';
    html += '<div class="carousel-dots">';
    for (var ti = 0; ti < tips.length; ti++) {
      html += '<button class="cdot' + (ti === 0 ? ' active' : '') + '" data-i="' + ti + '" aria-label="Tip ' + (ti+1) + '"></button>';
    }
    html += '</div></div>';

    document.getElementById('content').className = '';
    document.getElementById('content').innerHTML = html;

    // Animate progress fill
    setTimeout(function(){
      var pf = document.getElementById('progressFill');
      if (pf) pf.style.width = Math.min(100, Math.max(0, progressPct)) + '%';
    }, 120);

    // Logout
    document.getElementById('logoutBtn').addEventListener('click', function(){
      localStorage.removeItem('rw_referral');
      window.location.href = '/referral';
    });

    // Copy
    var copyBtn = document.getElementById('copyBtn');
    copyBtn.addEventListener('click', function(){
      var link = d.referral_link;
      function done(){
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = '<span>✓ Copied</span>';
        showToast('Link copied!');
        setTimeout(function(){
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = '<span>Copy Link</span>';
        }, 2000);
      }
      if (navigator.clipboard) {
        navigator.clipboard.writeText(link).then(done).catch(function(){
          var ta = document.createElement('textarea');
          ta.value = link; document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); done(); } catch(e) { showToast('Copy failed', true); }
          document.body.removeChild(ta);
        });
      } else {
        var ta = document.createElement('textarea');
        ta.value = link; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch(e) { showToast('Copy failed', true); }
        document.body.removeChild(ta);
      }
    });

    // WhatsApp share
    document.getElementById('shareBtn').addEventListener('click', function(){
      var msg = 'Create your AI resume in 5 minutes using ResumeWala.\\n\\nJust speak and your resume is ready.\\n\\nTry it here:\\n' + d.referral_link;
      window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
    });

    // Carousels
    setupCarousel('featCarousel', feats.length, 4000);
    setupCarousel('tipCarousel', tips.length, 4500);

    // Confetti — only when a NEW milestone was just hit
    try {
      var lastSeen = parseInt(localStorage.getItem('rw_last_count') || '-1', 10);
      var hitNew = (Math.floor(count / 5) > Math.floor(Math.max(lastSeen, 0) / 5) && count >= 5) ||
                   (count >= 51 && lastSeen < 51);
      if (hitNew) fireConfetti();
      localStorage.setItem('rw_last_count', String(count));
    } catch(e){}
  }

  load();
})();
` + '</script></body></html>';

module.exports = { LANDING_HTML, DASHBOARD_HTML };
