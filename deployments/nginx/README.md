# Local nginx front

`branch.undoo.ru` is expected to arrive from the external Nginx Proxy Manager
at this machine on `192.168.1.107:80`. The local nginx host config is:

~~~text
/etc/nginx/conf.d/branch.undoo.ru.conf
~~~

The config serves static files from:

~~~text
/var/www/branch
~~~

Build and install the current web shell:

~~~sh
npm --prefix web run build
sudo rsync -a --delete web/dist/ /var/www/branch/
sudo install -m 0644 deployments/nginx/branch.undoo.ru.conf /etc/nginx/conf.d/branch.undoo.ru.conf
sudo nginx -t
sudo systemctl reload nginx
~~~

This serves the local web shell only. It does not add a relay database, external
monitoring stack, protocol authority, or durable delivery path.
