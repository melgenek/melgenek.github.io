---
layout: post
title: Getting a development domain and TLS certificates for free
summary: "In this article we will see how to get a free domain name and issue valid TLS certificates using DuckDns
and Let's Encrypt in 2 simple steps. It takes only 5 minutes of time and requires Docker to be installed."
---

Recently I have been experimenting with Http/3 protocol which uses TLS by default.
Having self-signed TLS certificates makes browsers unhappy about the traffic, that's why I needed a way to get a trusted certificate.
While it took me more time than expected, I decided to write down the taken steps.

<nav>
  <h4>Table of Contents</h4>
  * TOC
  {:toc}
</nav>

Getting the domain and certificates
-------------------

This section walks through the process of getting a domain name and TLS certificates.

1. To start with, we need to have access to a DNS provider and a domain. I chose [DuckDNS](https://www.duckdns.org/) because it is absolutely
free and allows creating TXT DNS records, that are used to pass [the ACME DNS challenge](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge).
At DuckDNS we create our own domain and copy the token that looks like UUIDv4 string. This token is needed to update the DNS records via the DuckDNS api.

2. Next we pass the ACME challenge and get the TLS certificates utilising Let's Encrypt and CertBot. [Let's Encrypt](https://letsencrypt.org/) is the certificate authority
that issues certificates that are valid in all the browsers.
[CertBot](https://certbot.eff.org/) is a tool that is usually used to pass ACME challenges on a wide variety of server platforms.
Fortunately for us, [there is a docker container](https://github.com/maksimstojkovic/docker-letsencrypt) dedicated to getting certificates at Let's Encrypt for DuckDNS domains.
The usage is as easy as running this command in the terminal:
   
```shell
docker run -it --rm \
-e DUCKDNS_TOKEN="396db3e9-5ecc-4d0c-a708-70a926b1389c" \
-e DUCKDNS_DOMAIN="melgenek.duckdns.org" \
-v `pwd`/melgenek_certs:/etc/letsencrypt \
maksimstojkovic/letsencrypt:latest
```
   
In the `docker run` we specified the token that DuckDNS provides for accessing their API and my domain.
As a result of running this command the ACME challenge is succeeds,
and the volume attached to the container contains the certificates.
The private key and the public certificate can be found in the files `./melgenek_certs/live/melgenek.duckdns.org/privkey.pem` 
and `./melgenek_certs/live/melgenek.duckdns.org/cert.pem` respectively.

What has just happened
-------------------

The docker container that we used in the previous section did the needed magic to validate the DNS record and get the certificates.
In order to get the understanding of what the ACME flow looks like, let's generate one more certificate using the plain CertBot.
After passing the challenge, Let's Encrypt is sure that the domain is ours and gives us a certificate.

The first step is to start the CertBot flow. The CertBot is installed as [a standalone binary](https://certbot.eff.org/docs/install.html) 
and can be run from terminal. The command specifies for which domain we want to pass the DNS challenge and where to store the certificates.   

```shell
certbot certonly --manual \
   --preferred-challenges dns \
   --register-unsafely-without-email \
   -d "melgenek.duckdns.org" \
   --work-dir "./melgenek_certs/work_dir" \
   --logs-dir "./melgenek_certs/logs_dir" \
   --config-dir "./melgenek_certs/config_dir" \
   --agree-tos
```

As a result of the running the command CertBot generates a secret value and asks us to put it into the DNS record.

```shell
Please deploy a DNS TXT record under the name
_acme-challenge.melgenek.duckdns.org with the following value:

NaM0ODwHZfL6b1pjM_rrgfCSwVcy_CALKkxR2YzyE7A

Before continuing, verify the record is deployed.
- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
Press Enter to Continue
```

CertBot proposes to set the TXT record at the `_acme-challenge.melgenek.duckdns.org` subdomain. 
The validation of such a record would result in issuing a wildcard certificate for `*.melgenek.duckdns.org`.
We are setting the TXT record for the domain itself so that the certificate is valid only for the `melgenek.duckdns.org` domain.
The next cUrl call creates the TXT record in DuckDns. 

```shell
curl "https://www.duckdns.org/update?domains=melgenek.duckdns.org&token=396db3e9-5ecc-4d0c-a708-70a926b1389c&txt=NaM0ODwHZfL6b1pjM_rrgfCSwVcy_CALKkxR2YzyE7A"
```

Before proceeding with the ACME challenge, we can check that the DNS record is actually set using `dig`. 
In the lookup result we see that the TXT record is exactly what we expect it to be.

```shell
dig melgenek.duckdns.org TXT

;; ANSWER SECTION:
melgenek.duckdns.org.   59      IN      TXT     "NaM0ODwHZfL6b1pjM_rrgfCSwVcy_CALKkxR2YzyE7A"
```

Clicking "Enter" in the terminal where CertBot is waiting for input would trigger Let's Encrypt validation of the TXT record.
Passing this validation successfully produces certificates the specified folder `./melgenek_certs/config_dir/live/melgenek.duckdns.org`

The challenge secret is a not reused in the future, so it makes sense to clean up the TXT record. 
This is done by adding the `clear=true` query param to the previous cUrl query.  

```shell
curl "https://www.duckdns.org/update?domains=melgenek.duckdns.org&token=396db3e9-5ecc-4d0c-a708-70a926b1389c&txt=NaM0ODwHZfL6b1pjM_rrgfCSwVcy_CALKkxR2YzyE7A&clear=true"
```

Summary
-------------------

In this article we described a simple way of getting perfectly valid TLS certificates as wells as a domain that can be used for development purposes.
Hopefully, this information helps build exciting software and learn new technologies.
