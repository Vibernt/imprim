// The last element of every server page's <head>: a classic script, neither async nor deferred, after every stylesheet.
// Chromium runs it only once the stylesheets above have loaded, so the first paint never happens without Fire's CSS
// (Fire 0.12.3, "boot.js goes after the stylesheets"). Sign-in and consent pages load no Fire JavaScript, so this
// script is Imprim's own and does nothing else.
