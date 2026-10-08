/* React owns the desktop host; shared review markup and behavior load once. */
const { createElement: h, useEffect, useState } = React;
function DesktopHost() {
  const [markup, setMarkup] = useState(null);
  const [failure, setFailure] = useState(null);
  useEffect(() => {
    fetch('shared.html').then(response => response.text()).then(source => {
      const doc = new DOMParser().parseFromString(source, 'text/html');
      setMarkup(doc.body.innerHTML);
    }).catch(error => setFailure(error.message));
  }, []);
  useEffect(() => {
    if (markup !== null) import('./app.js').catch(error => setFailure(error.message));
  }, [markup]);
  return h(React.Fragment, null,
    failure ? h('p', { role: 'alert' }, failure) : null,
    markup === null ? h('p', { role: 'status' }, '正在准备桌面服务…') :
      h('div', { dangerouslySetInnerHTML: { __html: markup } }));
}
ReactDOM.createRoot(document.getElementById('desktop-root')).render(h(DesktopHost));
