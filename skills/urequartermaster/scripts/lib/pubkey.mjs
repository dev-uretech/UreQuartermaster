// Ed25519 public key (SPKI PEM) that every release must be signed with.
// The private key never enters this repository or its CI: the maintainer keeps it and signs releases locally.
export const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAyUGASaom8XfpuTLsZ5O0lVHUy4F2eIybQVA+D7+F37o=
-----END PUBLIC KEY-----
`;
