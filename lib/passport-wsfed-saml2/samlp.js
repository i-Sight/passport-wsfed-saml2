var xmldom      = require('xmldom');
var xpath       = require('xpath');
var qs          = require('querystring');
var zlib        = require('zlib');
var xtend       = require('xtend');
var url         = require('url');
var xmlenc      = require('xml-encryption');
var crypto      = require('crypto');
var querystring = require('querystring');
var SignedXml   = require('xml-crypto').SignedXml;
var templates   = require('./templates');

var AuthenticationFailedError = require('./errors/AuthenticationFailedError');

var BINDINGS = {
  HTTP_POST:      'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
  HTTP_REDIRECT:  'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'
};

var logLevel = process.env.LOG_LEVEL;
var isDebugMode =  logLevel === 'debug' || logLevel === 'trace';

console.debug = function(args)
{
  if (isDebugMode){
    console.log(args);
  }
};

var Samlp = module.exports = function Samlp (options, saml) {
  this.options = options || {};

  if (this.options.thumbprint) {
    this.options.thumbprints = (this.options.thumbprints || []).concat([this.options.thumbprint]);
  }

  if (typeof options.deflate === 'undefined') {
    this.options.deflate = true;
  }

  this._saml = saml;
};

function getProp(obj, path) {
  return path.split('.').reduce(function (prev, curr) {
    return prev[curr];
  }, obj);
}

var supplant = function (tmpl, o) {
  return tmpl.replace(/\@\@([^\@]*)\@\@/g,
    function (a, b) {
      var r = getProp(o, b);
      return typeof r === 'string' || typeof r === 'number' ? r : a;
    }
  );
};

var trimXml = function (xml) {
  return xml.replace(/\r\n/g, '')
      .replace(/\n/g,'')
      .replace(/>(\s*)</g, '><') //unindent
      .trim();
};

var removeHeaders = function  (cert) {
  var pem = /-----BEGIN (\w*)-----([^-]*)-----END (\w*)-----/g.exec(cert.toString());
  if (pem && pem.length > 0) {
    return pem[2].replace(/[\n|\r\n]/g, '');
  }
  return null;
};

var sign = function (content, key, algorithm) {
  var signer = crypto.createSign(algorithm.toUpperCase());
  signer.update(content);
  return signer.sign(key, 'base64');
};

var algorithms = {
  signature: {
    'rsa-sha256': 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    'rsa-sha1':  'http://www.w3.org/2000/09/xmldsig#rsa-sha1'
  },
  digest: {
    'sha256': 'http://www.w3.org/2001/04/xmlenc#sha256',
    'sha1': 'http://www.w3.org/2000/09/xmldsig#sha1'
  }
};

Samlp.prototype = {
  getSamlRequestParams: function (opts, callback) {
    var options = xtend(opts || {}, this.options);

    var signatureAlgorithm = options.signatureAlgorithm || 'rsa-sha256';
    var digestAlgorithm = options.digestAlgorithm || 'sha256';

    var assert_and_destination = templates.assert_and_destination({
      Destination: options.identityProviderUrl,
      AssertionConsumerServiceURL: options.callback
    });

    var model = {
      ID:               '_' + generateUniqueID(),
      IssueInstant:     generateInstant(),
      Issuer:           options.realm,
      ProtocolBinding:  options.protocolBinding || BINDINGS.HTTP_POST,
      ForceAuthn:       options.forceAuthn,
      AssertServiceURLAndDestination: assert_and_destination,
      AuthnContext:     options.authnContext || ''
    };

    if (options.requestContext) {
      model = xtend(model, options.requestContext);
    }

    var SAMLRequest = trimXml(!options.requestTemplate ? templates.samlrequest(model) : supplant(options.requestTemplate, model));
    var parsedUrl = url.parse(options.identityProviderUrl, true);
    var params = {
      SAMLRequest: null,
      RelayState: options.RelayState || (parsedUrl.query && parsedUrl.query.RelayState) || ''
    };

    if (options.protocolBinding === BINDINGS.HTTP_POST || !options.deflate) {
      // HTTP-POST or HTTP-Redirect without deflate encoding
      if (options.signingKey) {
        // xml with embedded Signature
        var sig = new SignedXml(null, { signatureAlgorithm: algorithms.signature[signatureAlgorithm] });
        sig.addReference(
          "//*[local-name(.)='AuthnRequest' and namespace-uri(.)='urn:oasis:names:tc:SAML:2.0:protocol']",
          ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
          algorithms.digest[digestAlgorithm]);

        sig.keyInfoProvider = {
          getKeyInfo: function () {
            return '<X509Data><X509Certificate>' + removeHeaders(options.signingKey.cert) + '</X509Certificate></X509Data>';
          }
        };

        sig.signingKey = options.signingKey.key;
        sig.computeSignature(SAMLRequest);

        SAMLRequest = trimXml(sig.getSignedXml());
      }

      params.SAMLRequest = new Buffer(SAMLRequest).toString('base64');
      return callback(null, params);
    }

    // HTTP-Redirect with deflate encoding (http://docs.oasis-open.org/security/saml/v2.0/saml-bindings-2.0-os.pdf - section 3.4.4.1)
    zlib.deflateRaw(new Buffer(SAMLRequest), function (err, buffer) {
      if (err) {
        console.error(err);
        return callback(err);
      }

      params.SAMLRequest = buffer.toString('base64');

      if (options.signingKey) {
        // construct the Signature: a string consisting of the concatenation of the SAMLRequest,
        // RelayState (if present) and SigAlg query string parameters (each one URLencoded)
        if (params.RelayState === '') {
          // if there is no RelayState value, the parameter should be omitted from the signature computation
          delete params.RelayState;
        }
        
        params.SigAlg = algorithms.signature[signatureAlgorithm];
        params.Signature = sign(querystring.stringify(params), options.signingKey.key, signatureAlgorithm);
      }

      callback(null, params);
    });
  },

  getSamlRequestUrl: function (opts, callback) {
    var options = xtend(opts || {}, this.options);
    var parsedUrl = url.parse(options.identityProviderUrl, true);

    this.getSamlRequestParams(options, function (err, params) {
      if (err) {
        console.error(err);
        return callback(err);
      }

      var samlRequestUrl = options.identityProviderUrl.split('?')[0] + '?' + qs.encode(xtend(parsedUrl.query, params));
      return callback(null, samlRequestUrl);
    });
  },

  getSamlRequestForm: function (opts, callback) {
    var options = xtend(opts || {}, this.options);

    this.getSamlRequestParams(options, function (err, params) {
      if (err) {
        console.error(err);
        return callback(err);
      }

      return callback(null, templates.form({
        postUrl:      options.identityProviderUrl,
        RelayState:   params.RelayState,
        SAMLRequest:  params.SAMLRequest
      }));
    });
  },

  decodeResponse: function(req) {
    var decoded = new Buffer(req.body['SAMLResponse'], 'base64').toString();
    return decoded;
  },

  extractAssertion: function(samlpResponse, callback) {
    if (typeof samlpResponse === 'string') {
      samlpResponse = new xmldom.DOMParser().parseFromString(samlpResponse);
    }

    var saml2Namespace = 'urn:oasis:names:tc:SAML:2.0:assertion';
    var done = function (err, assertion) {
      if (err) {
        console.error(err);
        return callback(err);
      }

      if (typeof assertion === 'string') {
        assertion = new xmldom.DOMParser().parseFromString(assertion);
      }

      // if saml assertion has a prefix but namespace is defined on parent, copy it to assertion
      if (assertion && assertion.prefix && !assertion.getAttributeNS(saml2Namespace, assertion.prefix)) {
        assertion.setAttribute('xmlns:' + assertion.prefix, assertion.lookupNamespaceURI(assertion.prefix));
      }

      callback(null, assertion);
    };

    var token = samlpResponse.getElementsByTagNameNS(saml2Namespace, 'Assertion')[0];
    if (!token) {
      // check for encrypted assertion
      var encryptedToken = samlpResponse.getElementsByTagNameNS(saml2Namespace, 'EncryptedAssertion')[0];
      if (encryptedToken) {

        var encryptedData = encryptedToken.getElementsByTagNameNS('http://www.w3.org/2001/04/xmlenc#', 'EncryptedData')[0];
        if (!encryptedData) {
          var errMsg = 'EncryptedData not found.';
          console.error(errMsg);
          return done(new Error(errMsg));
        }

        if (!this.options.decryptionKey) {
          var errMsgD = 'Assertion is encrypted. Please set options.decryptionKey with your decryption private key.';
          console.error(errMsgD);
          return done(new Error(errMsgD));
        }

        return xmlenc.decrypt(encryptedData.toString(), { key: this.options.decryptionKey, autopadding: this.options.autopadding }, done);
      }
    }

    done(null, token);
  },

  getSamlStatus: function (samlResponse) {
    var status = {};

    if (typeof samlResponse === 'string') {
      samlResponse = new xmldom.DOMParser().parseFromString(samlResponse);
    }

    // status code
    var statusCodeXml = xpath.select("//*[local-name(.)='Status']/*[local-name(.)='StatusCode']", samlResponse)[0];
    if (statusCodeXml) {
      status.code = statusCodeXml.getAttribute('Value');

      if (status.code === 'urn:oasis:names:tc:SAML:2.0:status:Responder') {
        // status sub code
        var statusSubCodeXml = xpath.select("//*[local-name(.)='Status']/*[local-name(.)='StatusCode']/*[local-name(.)='StatusCode']", samlResponse)[0];
        if (statusSubCodeXml) {
          status.subCode = statusSubCodeXml.getAttribute('Value');
        }
      }
    }

    // status message
    var samlStatusMsgXml = xpath.select("//*[local-name(.)='Status']/*[local-name(.)='StatusMessage']", samlResponse)[0];
    if (samlStatusMsgXml) {
      status.message = samlStatusMsgXml.textContent;
    }

    // status detail
    var samlStatusDetailXml = xpath.select("//*[local-name(.)='Status']/*[local-name(.)='StatusDetail']", samlResponse)[0];
    if (samlStatusDetailXml) {
      status.detail = samlStatusDetailXml.textContent;
    }

    return status;
  },

  validateSamlResponse: function (samlResponse, callback) {
    var self = this;

    console.debug('SAMLResponse', samlResponse);

    if (typeof samlResponse === 'string') {
      samlResponse = new xmldom.DOMParser().parseFromString(samlResponse);
    }

    // check status
    var samlStatus = self.getSamlStatus(samlResponse);
    var isAuthnFailed = samlStatus.code === 'urn:oasis:names:tc:SAML:2.0:status:AuthnFailed' ||
                        samlStatus.subCode === 'urn:oasis:names:tc:SAML:2.0:status:AuthnFailed';

    if (isAuthnFailed) {
      console.log('AuthenticationFailedError', samlStatus.message, samlStatus.detail);
      return callback (new AuthenticationFailedError(samlStatus.message, samlStatus.detail));
    }

    // extract assertion
    self.extractAssertion(samlResponse, function (err, assertion) {
      if (err) {
        console.error(err);
        return callback(err);
      }
      if (!assertion) {
        var errMsg = 'saml response does not contain an Assertion element';
        console.error(errMsg);
        return callback(new Error(errMsg));
      }

      var samlResponseSignaturePath = "//*[local-name(.)='Response']/*[local-name(.)='Signature' and namespace-uri(.)='http://www.w3.org/2000/09/xmldsig#']";
      var isResponseSigned = xpath.select(samlResponseSignaturePath, samlResponse).length > 0;
      var samlAssertionSignaturePath = "//*[local-name(.)='Assertion']/*[local-name(.)='Signature' and namespace-uri(.)='http://www.w3.org/2000/09/xmldsig#']";
      var isAssertionSigned =  xpath.select(samlAssertionSignaturePath, assertion).length > 0;

      if (!isResponseSigned && !isAssertionSigned) {
        var errMsgS = 'neither the response nor the assertion are signed';
        console.error(errMsgS);
        return callback(new Error(errMsgS));
      }

      if (isResponseSigned) {
        self._saml.validateSignature(samlResponse, {
          cert: self.options.cert,
          thumbprints: self.options.thumbprints,
          signaturePath: samlResponseSignaturePath
        },
        function (err) {
          if (err) {
            console.error(err);
            return callback(err);
          }

          if (!isAssertionSigned) {
            return self._saml.parseAssertion(assertion, callback);
          }

          return self._saml.validateSamlAssertion(assertion, callback);
        });
      }
      else if (isAssertionSigned) {
        return self._saml.validateSamlAssertion(assertion, callback);
      }
    });
  }
};

function generateUniqueID() {
  var chars = "abcdef0123456789";
  var uniqueID = "";
  for (var i = 0; i < 20; i++) {
    uniqueID += chars.substr(Math.floor((Math.random()*15)), 1);
  }
  return uniqueID;
}

function generateInstant() {
  var date = new Date();
  return date.getUTCFullYear() + '-' + ('0' + (date.getUTCMonth()+1)).slice(-2) + '-' + ('0' + date.getUTCDate()).slice(-2) + 'T' + ('0' + date.getUTCHours()).slice(-2) + ":" + ('0' + date.getUTCMinutes()).slice(-2) + ":" + ('0' + date.getUTCSeconds()).slice(-2) + "Z";
}
