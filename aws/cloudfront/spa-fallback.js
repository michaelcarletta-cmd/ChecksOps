function handler(event) {
  var request = event.request;
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
