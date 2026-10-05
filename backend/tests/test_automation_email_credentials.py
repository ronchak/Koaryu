"""Synthetic-only tests of private encrypted token storage."""

import json
from dataclasses import replace
from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet

from app.services.automation_email_credentials import (
    PROVIDER_KEY,
    CredentialCodec,
    CredentialConflict,
    CredentialError,
    CredentialRepository,
    CredentialState,
)

CLIENT_ID = "b31866c9-dfc5-47a7-9889-bb2c98359911"


def credential_state(**changes):
    return replace(
        CredentialState(
            client_id=CLIENT_ID,
            mailbox="koaryu@outlook.com",
            refresh_token="synthetic-refresh-only",
            access_token="synthetic-access-only",
            expires_at=2000000000,
        ),
        **changes,
    )


class FakeCredentialDatabase:
    def __init__(self, ciphertext=None, revision=0):
        self.ciphertext = ciphertext
        self.revision = revision
        self.calls = []
        self.on_execute = None

    def rpc(self, name, params):
        self.calls.append((name, params))

        def execute():
            if self.on_execute:
                result = self.on_execute(name, params)
                if result is not None:
                    return result
            if name == "save_automation_email_credential_v1":
                assert params["p_expected_revision"] == self.revision
                self.ciphertext = params["p_encrypted_credentials"]
                self.revision += 1
            else:
                assert name == "get_automation_email_credential_v1"
            return SimpleNamespace(
                data={
                    "provider_key": PROVIDER_KEY,
                    "revision": self.revision,
                    "encrypted_credentials": self.ciphertext,
                }
            )

        return SimpleNamespace(execute=execute)


@pytest.fixture
def codec():
    return CredentialCodec(Fernet.generate_key().decode(), CLIENT_ID, "koaryu@outlook.com")


def test_encrypt_decrypt_and_repository_rpc_only_receives_ciphertext(codec):
    state = credential_state()
    database = FakeCredentialDatabase()
    repository = CredentialRepository(database, codec)
    assert repository.load().state is None
    assert repository.load().revision == 0
    saved = repository.save(state, expected_revision=0)
    assert saved.revision == 1
    assert repository.load() == saved
    assert "synthetic-refresh-only" not in repr(database.calls)
    assert "synthetic-access-only" not in repr(database.calls)
    assert "synthetic-" not in repr(state)
    assert "synthetic-" not in repr(saved)
    assert "koaryu@outlook.com" not in repr(saved)


def test_codec_rejects_wrong_key_or_binding(codec):
    ciphertext = codec.encrypt(credential_state())
    wrong_key = CredentialCodec(Fernet.generate_key().decode(), CLIENT_ID, "koaryu@outlook.com")
    with pytest.raises(CredentialError, match="^credential_state_invalid$"):
        wrong_key.decrypt(ciphertext)
    with pytest.raises(CredentialError, match="^credential_binding_mismatch$"):
        codec.encrypt(credential_state(mailbox="another@example.com"))
    with pytest.raises(CredentialError, match="^credential_binding_mismatch$"):
        codec.encrypt(credential_state(client_id="other-client"))


@pytest.mark.parametrize("value", ["not-ciphertext", "", None, "💌", "a" * 131073])
def test_codec_rejects_bad_ciphertext(codec, value):
    with pytest.raises(CredentialError, match="^credential_state_invalid$"):
        codec.decrypt(value)


@pytest.mark.parametrize(
    "changes",
    [
        {"refresh_token": ""},
        {"refresh_token": "synthetic\nsecret"},
        {"access_token": "synthetic secret"},
        {"refresh_token": []},
        {"expires_at": float("nan")},
        {"expires_at": float("inf")},
        {"expires_at": -1},
        {"expires_at": True},
        {"expires_at": 10**400},
    ],
)
def test_codec_rejects_invalid_state(codec, changes):
    with pytest.raises(CredentialError, match="^credential_state_invalid$"):
        codec.encrypt(credential_state(**changes))


@pytest.mark.parametrize("payload", [[], {}, {"version": 99}, {"version": True}])
def test_codec_validates_decrypted_json_shape(payload):
    key = Fernet.generate_key()
    codec = CredentialCodec(key.decode(), CLIENT_ID, "koaryu@outlook.com")
    ciphertext = Fernet(key).encrypt(json.dumps(payload).encode()).decode()
    with pytest.raises(CredentialError, match="^credential_state_invalid$"):
        codec.decrypt(ciphertext)


def test_repository_hides_exception_details_and_does_not_chain_them(codec):
    database = FakeCredentialDatabase()

    def fail(name, params):
        raise RuntimeError("synthetic-access-only koaryu@outlook.com raw database details")

    database.on_execute = fail
    with pytest.raises(CredentialError) as caught:
        CredentialRepository(database, codec).load()
    assert str(caught.value) == "credential_store_unavailable"
    assert caught.value.__suppress_context__


def test_repository_maps_exact_cas_conflict(codec):
    class Conflict(Exception):
        code = "P0001"
        message = "AUTOMATION_EMAIL_CREDENTIAL_CONFLICT"

    database = FakeCredentialDatabase()

    def fail(name, params):
        raise Conflict("synthetic secret in raw provider exception")

    database.on_execute = fail
    with pytest.raises(CredentialConflict, match="^credential_conflict$"):
        CredentialRepository(database, codec).save(credential_state(), 0)


@pytest.mark.parametrize(
    "response",
    [
        None,
        {},
        [],
        {"provider_key": PROVIDER_KEY, "revision": True, "encrypted_credentials": None},
        {"provider_key": PROVIDER_KEY, "revision": 1, "encrypted_credentials": None},
        {"provider_key": "wrong-provider", "revision": 0, "encrypted_credentials": None},
    ],
)
def test_repository_rejects_malformed_envelopes(codec, response):
    database = FakeCredentialDatabase()
    database.on_execute = lambda name, params: SimpleNamespace(data=response)
    with pytest.raises(CredentialError):
        CredentialRepository(database, codec).load()


def test_save_requires_next_revision_and_same_ciphertext(codec):
    database = FakeCredentialDatabase()
    database.on_execute = lambda name, params: SimpleNamespace(
        data={
            "provider_key": PROVIDER_KEY,
            "revision": 0,
            "encrypted_credentials": params["p_encrypted_credentials"],
        }
    )
    with pytest.raises(CredentialError, match="^credential_store_unavailable$"):
        CredentialRepository(database, codec).save(credential_state(), 0)
