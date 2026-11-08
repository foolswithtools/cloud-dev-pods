// The pod sidecar's sign-in page under auth.browser.centralAuthHost (#144).
//
// oauth2-proxy v7.15.5's default pkg/app/pagewriter/sign_in.html, unchanged
// except for one script block (SIGN_IN_RD_SCRIPT) inserted after the stock
// "if (window.location.hash)" script, as recorded in #256's result comment:
// https://github.com/foolswithtools/cloud-dev-pods/issues/256#issuecomment-6722960101
//
// The script makes every rd input absolute on the pod's own origin, so the
// central host's callback can send the browser back to the pod instead of
// to auth.<baseDomain>. The owner-authz init container writes this file into
// the task's volume (owner-authz.ts); only sign_in.html is needed, because
// oauth2-proxy falls back to its built-in template per file.
//
// Bump with OAUTH2_PROXY_VERSION: re-copy the stock file at the new tag and
// re-insert the block. infra/test/owner-authz.test.ts pins the stock part by
// SHA-256 (SIGN_IN_STOCK_SHA256).

export const SIGN_IN_STOCK_SHA256 = '13b4095eff1ce35bd1e21e4f76902dfbe98490345147d77a9fe013d561514cdc';

export const SIGN_IN_RD_SCRIPT = `  <script>
    // cloud-dev-pods #256: make every rd absolute on this pod's own origin, so
    // the central auth host (auth.<base>) can send the browser back here.
    // The server-rendered value is relative (the ALB sends no X-Forwarded-Host).
    (function() {
      var inputs = document.getElementsByName('rd');
      for (var i = 0; i < inputs.length; i++) {
        inputs[i].value = new URL(inputs[i].value || '/', window.location.href).href;
      }
    })();
  </script>
`;

export const SIGN_IN_TEMPLATE = `{{define "sign_in.html"}}
<!DOCTYPE html>
<html lang="en" charset="utf-8">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
    <title>Sign In</title>
    <link rel="stylesheet" href="{{.ProxyPrefix}}/static/css/bulma.min.css">

    <style>
      body {
        height: 100vh;
      }
      .sign-in-box {
        max-width: 400px;
        margin: 1.25rem auto;
      }
      .logo-box {
        margin: 1.5rem 3rem;
      }
      .alert {
        padding: 5px;
        background-color: #f44336; /* Red */
        color: white;
        margin-bottom: 5px;
        border-radius: 5px
      }
      /* The close button */
      .closebtn {
        margin-left: 10px;
        color: white;
        font-weight: bold;
        float: right;
        font-size: 22px;
        line-height: 20px;
        cursor: pointer;
        transition: 0.3s;
      }
      /* When moving the mouse over the close button */
      .closebtn:hover {
        color: black;
      }
      footer a {
        text-decoration: underline;
      }
    </style>
  </head>
  <body class="has-background-light">
  <section class="section has-background-light">
    <div class="box block sign-in-box has-text-centered">
      {{ if .LogoData }}
      <div class="block logo-box">
        {{.LogoData}}
      </div>
      {{ end }}

      <form method="GET" action="{{.ProxyPrefix}}/start">
        <input type="hidden" name="rd" value="{{.Redirect}}">
          {{ if .SignInMessage }}
          <p class="block">{{.SignInMessage}}</p>
          {{ end}}
          <button type="submit" class="button block is-primary">Sign in with {{.ProviderName}}</button>
      </form>

      {{ if .CustomLogin }}
      <hr>

      <form method="POST" action="{{.ProxyPrefix}}/sign_in" class="block">
        <input type="hidden" name="rd" value="{{.Redirect}}">

        <div class="field">
          <label class="label" for="username">Username</label>
          <div class="control">
            <input class="input" type="text" placeholder="e.g. userx@example.com"  name="username" id="username">
          </div>
        </div>

        <div class="field">
          <label class="label" for="password">Password</label>
          <div class="control">
            <input class="input" type="password" placeholder="********" name="password" id="password">
          </div>
        </div>
        <button class="button is-primary">Sign in</button>
      </form>
      {{ end }}

      {{ if eq .StatusCode 400 401 }}
      <div class="alert">
        <span class="closebtn" onclick="this.parentElement.style.display='none';">&times;</span>
        {{ if eq .StatusCode 400 }}
        {{.StatusCode}}: Username cannot be empty
        {{ else }}
        {{.StatusCode}}: Invalid Username or Password
        {{ end }}
      </div> 
      {{ end }}

    </div>
  </section>

  <script>
    if (window.location.hash) {
      (function() {
        var inputs = document.getElementsByName('rd');
        for (var i = 0; i < inputs.length; i++) {
          // Add hash, but make sure it is only added once
          var idx = inputs[i].value.indexOf('#');
          if (idx >= 0) {
            // Remove existing hash from URL
            inputs[i].value = inputs[i].value.substr(0, idx);
          }
          inputs[i].value += window.location.hash;
        }
      })();
    }
  </script>
  <script>
    // cloud-dev-pods #256: make every rd absolute on this pod's own origin, so
    // the central auth host (auth.<base>) can send the browser back here.
    // The server-rendered value is relative (the ALB sends no X-Forwarded-Host).
    (function() {
      var inputs = document.getElementsByName('rd');
      for (var i = 0; i < inputs.length; i++) {
        inputs[i].value = new URL(inputs[i].value || '/', window.location.href).href;
      }
    })();
  </script>

  <footer class="footer has-text-grey has-background-light is-size-7">
    <div class="content has-text-centered">
    	{{ if eq .Footer "-" }}
    	{{ else if eq .Footer ""}}
    	<p>Secured with <a href="https://github.com/oauth2-proxy/oauth2-proxy#oauth2_proxy" class="has-text-grey">OAuth2 Proxy</a> version {{.Version}}</p>
    	{{ else }}
    	<p>{{.Footer}}</p>
    	{{ end }}
    </div>
	</footer>

  </body>
</html>
{{end}}
`;
