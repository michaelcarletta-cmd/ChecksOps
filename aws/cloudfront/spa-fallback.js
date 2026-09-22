function queryStringFromRequest(qs) {
  if (!qs || typeof qs !== 'object') return '';
  var parts = [];
  for (var key in qs) {
    if (!Object.prototype.hasOwnProperty.call(qs, key)) continue;
    var item = qs[key];
    if (!item) continue;
    if (item.multiValue) {
      for (var i = 0; i < item.multiValue.length; i++) {
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(item.multiValue[i].value));
      }
    } else if (item.value !== undefined) {
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(item.value));
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}

function handler(event) {
  var request = event.request;
  var host = '';
  if (request.headers && request.headers.host && request.headers.host.value) {
    host = String(request.headers.host.value).toLowerCase();
  }
  // Keep WebAuthn RP on checksops.com. Preserve path and query.
  if (host === 'www.checksops.com') {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: { value: 'https://checksops.com' + (request.uri || '/') + queryStringFromRequest(request.querystring) },
      },
    };
  }

  var uri = request.uri;

  // Attached only to the S3 default behavior. Still refuse to rewrite
  // /prep so an accidental association cannot HTML-ify the API.
  if (uri === "/prep" || uri.indexOf("/prep/") === 0) {
    return request;
  }

  var slash = uri.lastIndexOf("/");
  var last = slash === -1 ? uri : uri.substring(slash + 1);
  if (last.indexOf(".") !== -1) {
    return request;
  }

  request.uri = "/index.html";
  return request;
}
