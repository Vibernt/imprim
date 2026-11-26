// These marks are the providers’ trademarks, used to identify their sign-in options under their brand guidelines.
const marks = {
    github: ['0 0 16 16', '<path fill="light-dark(black, white)" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.55 7.55 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 8 0Z"/>'],
    microsoft: ['0 0 23 23', '<path fill="#F25022" d="M0 0h11v11H0z"/><path fill="#7FBA00" d="M12 0h11v11H12z"/><path fill="#00A4EF" d="M0 12h11v11H0z"/><path fill="#FFB900" d="M12 12h11v11H12z"/>'],
    apple: ['0 0 24 24', '<path fill="light-dark(black, white)" d="M17.05 12.54c.03 3.19 2.8 4.25 2.83 4.26-.02.08-.44 1.53-1.45 3.03-.87 1.3-1.77 2.59-3.21 2.62-1.41.03-1.86-.84-3.47-.84-1.61 0-2.12.82-3.45.87-1.38.05-2.44-1.4-3.31-2.69-1.79-2.63-3.16-7.43-1.32-10.66a5.04 5.04 0 0 1 4.27-2.64c1.36-.03 2.64.92 3.47.92.83 0 2.38-1.14 4.02-.97.68.03 2.59.28 3.81 2.09-.1.06-2.22 1.32-2.19 4.01M14.37 4.71c.72-.88 1.2-2.1 1.07-3.32-1.04.04-2.3.7-3.05 1.58-.67.77-1.25 2.01-1.09 3.2 1.16.09 2.35-.59 3.07-1.46"/>']
};
// Google's current "G" is a gradient its assets draw with inline styles, which the page's CSP forbids inline, so it is
// served as an image (public/imprim/google-g.svg, Google's own file with the button frame removed).
export function providerMark(type) {
    if (type === 'google') return '<img class="fd-icon" src="/imprim/google-g.svg" alt="" width="18" height="18">';
    if (!Object.hasOwn(marks, type)) return '';
    const [viewBox, shapes] = marks[type];
    return `<svg class="fd-icon" viewBox="${viewBox}" aria-hidden="true" focusable="false"><g stroke="none">${shapes}</g></svg>`;
}
