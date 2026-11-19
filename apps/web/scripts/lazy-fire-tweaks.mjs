// Fire keeps every look and dial when Tweaks is used. Split out only the panel's entry points,
// so Branding can load them independently of the Fire styles and behaviours shared by the app.
export function lazyFireTweaks() {
  return {
    name: 'im-lazy-fire-tweaks',
    enforce: 'pre',
    transform(source, id) {
      if (/\/(?:\.fire-slim|fire)\/fire\.js$/.test(id)) {
        const moduleImport = /^import \* as tweaks from ['"][^'"]+['"];\n/m;
        const lists = /^((?:const modules = |export )\{)([^}]+)(\}.*)$/gm;
        if (!moduleImport.test(source)) this.error('The Fire entry changed. Review the lazy Tweaks integration.');
        return {
          code: source.replace(moduleImport, '').replace(lists, (_, start, members, end) =>
            start + ' ' + members.split(',').map(member => member.trim()).filter(member => member !== 'tweaks').join(', ') + ' ' + end),
          map: null,
        };
      }
      if (id.endsWith('/.fire-slim/fire.css')) {
        const panel = /\/\* fire\/components\/tweaks\.css \*\/[\s\S]*?(?=\/\* fire\/|$)/;
        if (!panel.test(source)) this.error('Fire slim changed the Tweaks CSS entry. Review the lazy Tweaks integration.');
        return { code: source.replace(panel, ''), map: null };
      }
      if (id.endsWith('/fire/fire.css')) {
        const panelImport = /^@import "\.\/components\/tweaks\.css";\n/m;
        if (!panelImport.test(source)) this.error('Fire changed the Tweaks CSS entry. Review the lazy Tweaks integration.');
        return { code: source.replace(panelImport, ''), map: null };
      }
    },
  };
}
