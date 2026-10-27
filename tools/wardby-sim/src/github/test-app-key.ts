// TEST ONLY (wardby-sim). The simulated GitHub App's key pair. The private half is committed
// on purpose at tools/wardby-sim/fixtures/github-app-test-key.pem: it authenticates nothing
// but this simulator. wardby's WARDBY_TEST_SIMULATORS switch refuses to start with any other
// GitHub App key (src/config/test-simulators.ts checks this fingerprint), so a real App's key
// can never sign a JWT that reaches the simulator.

export const SIM_APP_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6cBLjJVsiMuYvxZf4hxY
dHF/2pmKKWb8u667YRYE822URuCNbqbTN+89IHqDjLrn/0O6/IeWO2TXLTXvFG8E
Mny4i3kRXg4fKRvm8agvxT5bbx8Xis6Rg49PqKo/IkXzoI4dAyRVz6nFJMAlI8zx
2HgDyLXopliIjFgaS54ijL9HT8lu4RLZFwYEoUAfM9PZACVm7fbM24JFWNOv6cVN
j3RhuHw8Ks2AMkE2l8BPJzacNHPwaZSr8Mu/hjLUkXnkX+wMx+ENWYYMuUZDibiY
40y/DvkFVqFAJQ2duoa3F+gCljyyh2qD/uKkBiY0mXq6N0KpLM7JbS8D/gN4vHRP
jQIDAQAB
-----END PUBLIC KEY-----
`;

/** SHA-256 of the public key's SPKI DER, hex. */
export const SIM_APP_KEY_FINGERPRINT = "dac6c80f55da011bbd2ed5868c61972f778853069f125946964e093e51a7d141";

/** The simulated App's defaults. */
export const SIM_APP_ID = 424242;
export const SIM_APP_SLUG = "wardby-sim";
