/* dict_test.js – tokenise subtitle + global toast */
console.log('[dict-test] module loaded');

const segmenter = typeof TinySegmenter === 'function'
  ? new TinySegmenter()
  : { segment: s => s.split(/(\\s+)/) };

/* global toast --------------------------------------------------- */
window.showToast = function (message, x, y) {
  let t = document.getElementById('dictGlobalToast');
  if (!t) {
    t = Object.assign(document.createElement('div'), { id:'dictGlobalToast' });
    Object.assign(t.style, {
      position:'fixed', left:'50%', transform:'translateX(-50%)',
      bottom:'40px', background:'#222', color:'#fff',
      padding:'10px 20px', borderRadius:'20px', opacity:'0.95',
      fontSize:'14px', zIndex:'9999', pointerEvents:'none'
    });
    document.body.appendChild(t);
  }
  t.textContent = message;
  if (x !== undefined && y !== undefined) { t.style.left = x + 'px'; t.style.top = y + 'px'; }
  t.style.display = 'block';
  clearTimeout(t._hide); t._hide = setTimeout(()=>t.style.display='none',1500);
};

/* tokenise -------------------------------------------------------- */
function wrapSubtitle() {
  const el = document.querySelector('.subtitle-text');
  if (!el) return;
  const tokens = segmenter.segment(el.textContent);
  el.innerHTML = tokens.map(tok =>
    tok.trim() ? `<span class="dict-token">${tok}</span>` : tok
  ).join('');
  console.log('[dict-test] subtitle tokenised');
}
/* make it visible to app.js */
window.wrapSubtitleTokens = wrapSubtitle;

/* click handler --------------------------------------------------- */
document.addEventListener('click', e => {
  if (e.target.classList.contains('dict-token')) {
    window.showToast('Clicked: ' + e.target.textContent.trim(), e.clientX, e.clientY);
  }
});

/* minimal CSS ----------------------------------------------------- */
if (!document.getElementById('dictTokenCSS')) {
  const s = document.createElement('style');
  s.id  = 'dictTokenCSS';
  s.textContent = `.dict-token{cursor:pointer}.dict-token:hover{background:#335}`;
  document.head.appendChild(s);
}
