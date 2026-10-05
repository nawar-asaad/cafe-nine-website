/*
 * توقيع Basira Tech: يوضع في أسفل أي منتج من منتجات بصيرة تك.
 * الاستخدام: <basira-credit></basira-credit> بعد تحميل هذا الملف.
 *   label  : النص قبل الشعار (الافتراضي «تصميم وتطوير»)
 *   accent : لون نقطة المركز (الافتراضي ذهبي بصيرة تك)
 * يأخذ لون النص من المكان الذي يوضع فيه، فيندمج مع ألوان كل مشروع.
 */
(function () {
  if (customElements.get('basira-credit')) return;
  var DOTS = [[-12,-24,2.5],[0,-24,3.5],[12,-24,2.5],[-30,-12,2.5],[-18,-12,3.5],[-6,-12,4.5],[6,-12,4.5],[18,-12,3.5],[30,-12,2.5],[-36,0,2.5],[-24,0,3.5],[-12,0,4.5],[12,0,4.5],[24,0,3.5],[36,0,2.5],[-30,12,2.5],[-18,12,3.5],[-6,12,4.5],[6,12,4.5],[18,12,3.5],[30,12,2.5],[-12,24,2.5],[0,24,3.5],[12,24,2.5]];
  var MARK = '<svg viewBox="-42 -30 84 60" aria-hidden="true">' +
    DOTS.map(function (d) { return '<circle cx="' + d[0] + '" cy="' + d[1] + '" r="' + d[2] + '"/>'; }).join('') +
    '<circle class="c" r="7"/></svg>';
  customElements.define('basira-credit', class extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      var label = (this.getAttribute('label') || 'تصميم وتطوير').replace(/[<>&"]/g, '');
      var accent = (this.getAttribute('accent') || '#E9A820').replace(/[^#\w(),.% -]/g, '');
      this.attachShadow({ mode: 'open' }).innerHTML =
        '<style>' +
        ':host{display:inline-block;font-size:12px;line-height:1;color:inherit}' +
        'a{display:inline-flex;align-items:center;gap:7px;color:inherit;text-decoration:none;opacity:.72;transition:opacity .2s}' +
        'a:hover,a:focus-visible{opacity:1}' +
        'span{white-space:nowrap}' +
        'svg{width:1.9em;height:auto;flex:none;fill:currentColor}' +
        'svg circle{opacity:.85}svg .c{fill:' + accent + ';opacity:1}' +
        'b{font:600 1.08em/1 Poppins,"Segoe UI",system-ui,sans-serif;letter-spacing:-.2px;direction:ltr;white-space:nowrap}' +
        'b i{font-style:normal;font-weight:500}' +
        '@media print{a{opacity:1}}' +
        '</style>' +
        '<a href="https://www.instagram.com/basira_tech/" target="_blank" rel="noopener" title="Basira Tech · بصيرة تك">' +
        '<span>' + label + '</span>' + MARK + '<b>Basira <i>Tech</i></b></a>';
    }
  });
})();
