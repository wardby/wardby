/**
 * Secrets seam — encryption of secret values at rest.
 *
 * reevo-run uses its own key and its own ciphertext format, independent of any
 * other system. `encrypt` returns a self-describing blob (algorithm + key id +
 * IV + ciphertext) so values can be rotated and re-encrypted without ambiguity
 * — this is what makes a one-time migration onto reevo-run clean.
 *
 * Default adapter: AppKeySecretCipher (AES-GCM with an app master key).
 * Native adapter:  KmsSecretCipher (envelope encryption via a KMS key).
 */

export interface SecretCipher {
  /** Identifier of the active key/version, for rotation and envelope reference. */
  keyId(): string;
  /** Encrypt to a self-describing blob (algorithm + keyId + IV + ciphertext). */
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}
