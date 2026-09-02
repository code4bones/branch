# Local nginx front

`branch.undoo.ru` is expected to arrive from the external Nginx Proxy Manager
at this machine on `192.168.1.107:80`. The local nginx host config is:

~~~text
/etc/nginx/conf.d/branch.undoo.ru.conf
~~~

For local development the config serves static files directly from the current
web build output:

~~~text
/home/code4bones/Devs/coding/BRANCH/web/dist
~~~

Build the current web shell:

~~~sh
npm --prefix web run build
~~~

Install or refresh the local nginx config:

~~~sh
sudo install -m 0644 deployments/nginx/branch.undoo.ru.conf /etc/nginx/conf.d/branch.undoo.ru.conf
sudo nginx -t
sudo systemctl reload nginx
~~~

If `/etc/nginx/conf.d/branch.undoo.ru.conf` is a symlink to this repository
file, only `npm --prefix web run build`, `sudo nginx -t`, and
`sudo systemctl reload nginx` are needed after config changes. Routine web
changes only need a rebuild because nginx reads `web/dist` directly.

The nginx worker user must be able to traverse `/home/code4bones` and read
`web/dist`. On the local Ubuntu install this is usually `www-data`; verify with
`ps -eo user,group,comm | grep nginx` and `namei -l web/dist/index.html`.
Grant access with a local ACL or equivalent operator-owned permission change,
for example:

~~~sh
sudo setfacl -m u:www-data:--x /home/code4bones
sudo setfacl -R -m u:www-data:rx /home/code4bones/Devs/coding/BRANCH/web/dist
~~~

The previous `/var/www/branch` artifact root remains useful for production-like
copy deployments, but it is intentionally not used by this local development
config.

The local beta UI can be protected with nginx Basic Auth without blocking relay
traffic. Keep the external Nginx Proxy Manager host-level Access List disabled
for `branch.undoo.ru`; local nginx protects static UI paths and explicitly
leaves `/node-admin/` and `/relay/v0` outside Basic Auth. `/node-admin/` remains
protected by the branch-node bearer token, and relay monitor ingestion remains
protected by the dedicated monitor bearer token.

The React admin shell uses Ant Design 5. The `/admin/` location therefore has a
path-scoped CSP that permits `style-src 'self' 'unsafe-inline'` for AntD runtime
style injection. Do not add `unsafe-inline` to `script-src`; the relaxation is
only for admin presentation styles and does not apply to relay or node-admin
traffic.

For the local ignored two-line `.basicauth` file:

~~~text
USERNAME=<operator user>
PASSWORD=<operator password>
~~~

create the ignored htpasswd file used by nginx:

~~~sh
u=$(sed -n 's/^USERNAME=//p' .basicauth | head -n 1)
p=$(sed -n 's/^PASSWORD=//p' .basicauth | head -n 1)
htpasswd -bcB .branch.htpasswd "$u" "$p"
chgrp www-data .branch.htpasswd
chmod 0640 .branch.htpasswd
sudo nginx -t
sudo systemctl reload nginx
~~~

The `/node-admin/` location proxies to the protected local `branch-node` admin
listener on `127.0.0.1:8081`. It exists so the open developer admin front can
request relay-owned BootstrapBeacon wrappers through same-origin browser fetches
while the branch-node admin token still gates the protected endpoint.

This serves the local web shell only. It does not add a relay database, external
monitoring stack, protocol authority, or durable delivery path.
