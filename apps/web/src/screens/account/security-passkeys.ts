import { post } from './account-screen';

type EncodedDescriptor = Omit<PublicKeyCredentialDescriptor, 'id'> & { id: string };
type EncodedOptions = Omit<PublicKeyCredentialCreationOptions, 'challenge' | 'user' | 'excludeCredentials'> & {
  challenge: string;
  user: Omit<PublicKeyCredentialUserEntity, 'id'> & { id: string };
  excludeCredentials: EncodedDescriptor[];
};
interface AddedPasskey { added: boolean; name: string; recovery_codes: string[] }

const decode = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
const encode = (buffer: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function createPasskey(name: FormDataEntryValue | null, signal: AbortSignal) {
  const { publicKey } = await post<{ publicKey: EncodedOptions }>('passkeys/options');
  const credential = await navigator.credentials.create({ signal, publicKey: {
    ...publicKey, challenge: decode(publicKey.challenge), user: { ...publicKey.user, id: decode(publicKey.user.id) },
    excludeCredentials: publicKey.excludeCredentials.map(item => ({ ...item, id: decode(item.id) })),
  } });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse)) throw new Error('Passkey registration was incomplete.');
  signal.throwIfAborted();
  return post<AddedPasskey>('passkeys/register', {
    name, clientDataJSON: encode(credential.response.clientDataJSON), attestationObject: encode(credential.response.attestationObject),
  });
}
