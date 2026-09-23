# Eliza Cloud SDK

`elizaos-cloud-sdk-679ea26dfa1d.tgz` is the immutable SDK package built from Cloud source
`679ea26dfa1d0aad8c449664beb1ece06ba78e85`. The adjacent manifest records its source tree and SHA-256.

It uses the generic `/billing/accounts/resolve` endpoint and requires JSON results
for typed billing, inference, and delegation management operations. The archive includes the upstream MIT
license. It is a local release candidate; it does not prove npm publication or
availability of the matching deployed Cloud APIs.

The generated route catalog excludes the retired `/api/v1/outreachr` endpoints.
Product behavior remains in Outreachr and uses the generic app APIs.
