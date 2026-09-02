FROM scratch

LABEL org.opencontainers.image.title="B.R.A.N.C.H. branch-node"
LABEL org.branch.role="relay-node"

COPY ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY branch-node /branch-node

EXPOSE 8080

ENTRYPOINT ["/branch-node"]
