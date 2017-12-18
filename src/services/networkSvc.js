import utils from './utils';
import store from '../store';

const scriptLoadingPromises = Object.create(null);
const oauth2AuthorizationTimeout = 120 * 1000; // 2 minutes
const networkTimeout = 30 * 1000; // 30 sec
let isConnectionDown = false;

export default {
  loadScript(url) {
    if (!scriptLoadingPromises[url]) {
      scriptLoadingPromises[url] = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.onload = resolve;
        script.onerror = () => {
          scriptLoadingPromises[url] = null;
          reject();
        };
        script.src = url;
        document.head.appendChild(script);
      });
    }
    return scriptLoadingPromises[url];
  },
  startOauth2(url, params = {}, silent = false) {
    // Build the authorize URL
    const state = utils.uid();
    params.state = state;
    params.redirect_uri = utils.oauth2RedirectUri;
    const authorizeUrl = utils.addQueryParams(url, params);

    let iframeElt;
    let wnd;
    if (silent) {
      // Use an iframe as wnd for silent mode
      iframeElt = document.createElement('iframe');
      iframeElt.style.position = 'absolute';
      iframeElt.style.left = '-9999px';
      iframeElt.src = authorizeUrl;
      document.body.appendChild(iframeElt);
      wnd = iframeElt.contentWindow;
    } else {
      // Open a tab otherwise
      wnd = window.open(authorizeUrl);
      if (!wnd) {
        return Promise.reject('The authorize window was blocked.');
      }
    }

    return new Promise((resolve, reject) => {
      let checkClosedInterval;
      let closeTimeout;
      let msgHandler;
      let clean = () => {
        clearInterval(checkClosedInterval);
        if (!silent && !wnd.closed) {
          wnd.close();
        }
        if (iframeElt) {
          document.body.removeChild(iframeElt);
        }
        clearTimeout(closeTimeout);
        window.removeEventListener('message', msgHandler);
        clean = () => Promise.resolve(); // Prevent from cleaning several times
        return Promise.resolve();
      };

      if (silent) {
        iframeElt.onerror = () => clean()
          .then(() => reject('Unknown error.'));
        closeTimeout = setTimeout(
          () => clean()
            .then(() => {
              isConnectionDown = true;
              store.commit('setOffline', true);
              store.commit('updateLastOfflineCheck');
              reject('You are offline.');
            }),
          networkTimeout);
      } else {
        closeTimeout = setTimeout(
          () => clean()
            .then(() => reject('Timeout.')),
          oauth2AuthorizationTimeout);
      }

      msgHandler = event => event.source === wnd && event.origin === utils.origin && clean()
        .then(() => {
          const data = utils.parseQueryParams(`${event.data}`.slice(1));
          if (data.error || data.state !== state) {
            console.error(data); // eslint-disable-line no-console
            reject('Could not get required authorization.');
          } else {
            resolve({
              accessToken: data.access_token,
              code: data.code,
              idToken: data.id_token,
              expiresIn: data.expires_in,
            });
          }
        });

      window.addEventListener('message', msgHandler);
      if (!silent) {
        checkClosedInterval = setInterval(() => wnd.closed && clean()
          .then(() => reject('Authorize window was closed.')), 250);
      }
    });
  },
  request(configParam, offlineCheck = false) {
    let retryAfter = 500; // 500 ms
    const maxRetryAfter = 10 * 1000; // 10 sec
    const config = Object.assign({}, configParam);
    config.timeout = config.timeout || networkTimeout;
    config.headers = Object.assign({}, config.headers);
    if (config.body && typeof config.body === 'object') {
      config.body = JSON.stringify(config.body);
      config.headers['Content-Type'] = 'application/json';
    }

    function parseHeaders(xhr) {
      const pairs = xhr.getAllResponseHeaders().trim().split('\n');
      return pairs.reduce((headers, header) => {
        const split = header.trim().split(':');
        const key = split.shift().trim().toLowerCase();
        const value = split.join(':').trim();
        headers[key] = value;
        return headers;
      }, {});
    }

    function isRetriable(err) {
      if (err.status === 403) {
        const googleReason = ((((err.body || {}).error || {}).errors || [])[0] || {}).reason;
        return googleReason === 'rateLimitExceeded' || googleReason === 'userRateLimitExceeded';
      }
      return err.status === 429 || (err.status >= 500 && err.status < 600);
    }

    const attempt =
      () => new Promise((resolve, reject) => {
        if (offlineCheck) {
          store.commit('updateLastOfflineCheck');
        }
        const xhr = new window.XMLHttpRequest();
        let timeoutId;

        xhr.onload = () => {
          if (offlineCheck) {
            isConnectionDown = false;
          }
          clearTimeout(timeoutId);
          const result = {
            status: xhr.status,
            headers: parseHeaders(xhr),
            body: config.blob ? xhr.response : xhr.responseText,
          };
          if (!config.raw && !config.blob) {
            try {
              result.body = JSON.parse(result.body);
            } catch (e) {
              // ignore
            }
          }
          if (result.status >= 200 && result.status < 300) {
            resolve(result);
            return;
          }
          reject(result);
        };

        xhr.onerror = () => {
          clearTimeout(timeoutId);
          if (offlineCheck) {
            isConnectionDown = true;
            store.commit('setOffline', true);
            reject('You are offline.');
          } else {
            reject('Network request failed.');
          }
        };

        timeoutId = setTimeout(() => {
          xhr.abort();
          if (offlineCheck) {
            isConnectionDown = true;
            store.commit('setOffline', true);
            reject('You are offline.');
          } else {
            reject('Network request timeout.');
          }
        }, config.timeout);

        const url = utils.addQueryParams(config.url, config.params);
        xhr.open(config.method || 'GET', url);
        Object.keys(config.headers).forEach((key) => {
          const value = config.headers[key];
          if (value) {
            xhr.setRequestHeader(key, `${value}`);
          }
        });
        if (config.blob) {
          xhr.responseType = 'blob';
        }
        xhr.send(config.body || null);
      })
        .catch((err) => {
          // Try again later in case of retriable error
          if (isRetriable(err) && retryAfter < maxRetryAfter) {
            return new Promise(
              (resolve) => {
                setTimeout(resolve, retryAfter);
                // Exponential backoff
                retryAfter *= 2;
              })
              .then(attempt);
          }
          throw err;
        });

    return attempt();
  },
};

function checkOffline() {
  const isBrowserOffline = window.navigator.onLine === false;
  if (!isBrowserOffline &&
    store.state.lastOfflineCheck + networkTimeout + 5000 < Date.now() &&
    utils.isUserActive()
  ) {
    store.commit('updateLastOfflineCheck');
    new Promise((resolve, reject) => {
      const script = document.createElement('script');
      let timeout;
      let clean = (cb) => {
        clearTimeout(timeout);
        document.head.removeChild(script);
        clean = () => {}; // Prevent from cleaning several times
        cb();
      };
      script.onload = () => clean(resolve);
      script.onerror = () => clean(reject);
      script.src = `https://apis.google.com/js/api.js?${Date.now()}`;
      try {
        document.head.appendChild(script); // This can fail with bad network
        timeout = setTimeout(() => clean(reject), networkTimeout);
      } catch (e) {
        reject(e);
      }
    })
      .then(() => {
        isConnectionDown = false;
      }, () => {
        isConnectionDown = true;
      });
  }
  const offline = isBrowserOffline || isConnectionDown;
  if (store.state.offline !== offline) {
    store.commit('setOffline', offline);
    if (offline) {
      store.dispatch('notification/error', 'You are offline.');
    } else {
      store.dispatch('notification/info', 'You are back online!');
    }
  }
}

utils.setInterval(checkOffline, 1000);
window.addEventListener('online', () => {
  isConnectionDown = false;
  checkOffline();
});
window.addEventListener('offline', checkOffline);
