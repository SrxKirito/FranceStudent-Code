"use strict";
// On Windows, enterprise proxies can be trusted by the OS but absent from
// Node's bundled CA list. Keep certificate verification enabled and add only
// the certificates already trusted by the operating system.
if (process.platform === "win32") {
    const tls = require("node:tls");
    if (typeof tls.getCACertificates === "function" && typeof tls.setDefaultCACertificates === "function") {
        tls.setDefaultCACertificates([...tls.getCACertificates("default"), ...tls.getCACertificates("system")]);
    }
}
