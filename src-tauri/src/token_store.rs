// Secure storage for the Google OAuth refresh token.
//
// WHY this exists: the refresh token is a long-lived credential — anyone who
// holds it can mint new access tokens and take over the user's Google Drive
// account permanently. Google's OAuth best practices require storing it
// securely (https://developers.google.com/identity/protocols/oauth2/resources/best-practices),
// so it lives in the OS credential vault — Windows Credential Manager via the
// `keyring` crate (v1 feature auto-selects the platform store), and the
// Android Keystore-backed SharedPreferences store on Android — instead of
// plaintext WebView localStorage, which any XSS could exfiltrate.
//
// The short-lived access token (~1h expiry) intentionally stays in the
// frontend (localStorage): its exposure window is bounded, and keeping it
// client-side avoids a backend round-trip on every API call.
//
// Android specifics: keyring's v1 one-time store initializer has no Android
// arm (keyring-4.1.6 src/v1.rs:109-129), so `keyring::Entry::new` always
// fails with NoDefaultStore there. We therefore bypass v1 on Android and call
// `keyring_core` directly after installing the Android Keystore store as the
// default (see `android_keystore`). The `android-native-keyring-store` crate
// also requires the ndk-context application-context to be initialized; tauri
// 2.11/tao 0.35 no longer does that (upstream issue
// open-source-cooperative/android-native-keyring-store#21), so we initialize
// it ourselves from Rust via `JNI_OnLoad` (ART hands the process JavaVM to
// it on library load — `JNI_GetCreatedJavaVMs` is not exported on Android)
// plus reflection, with no Kotlin changes and no extra .so needed.
#[cfg(not(target_os = "android"))]
use keyring::Entry;

/// Service name under which the refresh token is stored in the OS keychain.
const SERVICE_NAME: &str = "drplay";
/// Entry key (username) under the service: the app uses a single Google
/// account at a time, so a fixed key is sufficient.
const REFRESH_TOKEN_USER: &str = "refresh_token";

/// The keyring entry type: v1 `keyring::Entry` on desktop, and
/// `keyring_core::Entry` on Android (v1's `Entry::new` cannot work there —
/// see module docs). Both expose the same set/get/delete methods and the same
/// `keyring_core::Error` type, so the command bodies below are shared.
#[cfg(not(target_os = "android"))]
type VaultEntry = Entry;
#[cfg(target_os = "android")]
type VaultEntry = keyring_core::Entry;

#[cfg(target_os = "android")]
mod android_keystore {
    use std::ffi::c_void;
    use std::sync::{Mutex, OnceLock};

    use jni::objects::GlobalRef;
    use jni::sys::jint;
    use jni::JavaVM;

    /// One-time result of the Android Keystore store initialization.
    /// The `Err` never contains credential material (no token).
    static INIT_RESULT: OnceLock<Result<(), String>> = OnceLock::new();

    /// The process JavaVM, captured by `JNI_OnLoad` (see below). ART calls
    /// `JNI_OnLoad` with the VM pointer the moment `System.loadLibrary`
    /// succeeds — before any Rust command can run — so this is always set by
    /// the time a command touches the credential store.
    static JAVA_VM: Mutex<Option<JavaVM>> = Mutex::new(None);

    /// JNI entry point ART invokes right after `System.loadLibrary` loads this
    /// .so. It is the only guaranteed way to obtain the process JavaVM on
    /// Android: `JNI_GetCreatedJavaVMs` is NOT an exported symbol of libart,
    /// so referencing it makes the dynamic linker fail the entire library with
    /// `UnsatisfiedLinkError` (`dlopen failed: cannot locate symbol
    /// "JNI_GetCreatedJavaVMs"`) — the startup crash this module used to
    /// cause. Returns the minimum JNI version the code supports.
    #[no_mangle]
    pub extern "system" fn JNI_OnLoad(vm: JavaVM, _reserved: *mut c_void) -> jint {
        match JAVA_VM.lock() {
            Ok(mut guard) => *guard = Some(vm),
            // Poisoning is unreachable (no panic while the lock is held); take
            // the lock back rather than aborting across the FFI boundary.
            Err(poisoned) => *poisoned.into_inner() = Some(vm),
        }
        jni::sys::JNI_VERSION_1_6
    }

    /// Install the Android Keystore credential store as the keyring default,
    /// exactly once per process. Returns a contextual error on any failure.
    pub fn ensure() -> Result<(), String> {
        INIT_RESULT.get_or_init(initialize).clone()
    }

    fn initialize() -> Result<(), String> {
        let vm = find_java_vm()?;
        let context = find_application_context(&vm)?;
        // SAFETY: `initialize_android_context` is called exactly once (guarded
        // by INIT_RESULT above); the VM pointer stays valid for the process
        // lifetime, and the context is a global ref we deliberately leak so it
        // outlives any activity recreation.
        unsafe {
            ndk_context::initialize_android_context(
                vm.get_java_vm_pointer().cast(),
                context,
            );
        }
        let store = android_native_keyring_store::Store::new()
            .map_err(|e| format!("Android Keystore store creation failed: {e}"))?;
        keyring_core::set_default_store(store);
        Ok(())
    }

    /// Return the process JavaVM captured by `JNI_OnLoad`. The JNI invocation
    /// API's `JNI_GetCreatedJavaVMs` cannot be used on Android (libart does
    /// not export the symbol — see `JNI_OnLoad` above). The VM pointer is
    /// valid for the process lifetime, so re-wrapping it on each call is safe.
    fn find_java_vm() -> Result<JavaVM, String> {
        let guard = match JAVA_VM.lock() {
            Ok(g) => g,
            // Poisoning is unreachable (no panic while the lock is held).
            Err(poisoned) => poisoned.into_inner(),
        };
        let vm = guard.as_ref().ok_or_else(|| {
            "JNI_OnLoad not called yet (no JavaVM captured by ART)".to_string()
        })?;
        // SAFETY: `from_raw` only null-checks (jni-0.21.1
        // src/wrapper/java_vm/vm.rs:239-244); the captured VM pointer remains
        // valid for the process lifetime.
        unsafe { JavaVM::from_raw(vm.get_java_vm_pointer()) }.map_err(|e| e.to_string())
    }

    /// Obtain the application `Context` via `ActivityThread.currentApplication()`
    /// and return it as a process-lifetime global ref (deliberately leaked).
    fn find_application_context(vm: &JavaVM) -> Result<*mut c_void, String> {
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let class = env
            .find_class("android/app/ActivityThread")
            .map_err(|e| format!("android/app/ActivityThread not found: {e}"))?;
        let app = env
            .call_static_method(class, "currentApplication", "()Landroid/app/Application;", &[])
            .map_err(|e| format!("ActivityThread.currentApplication() failed: {e}"))?
            .l()
            .map_err(|e| format!("ActivityThread.currentApplication() result invalid: {e}"))?;
        if app.is_null() {
            return Err(
                "ActivityThread.currentApplication() returned null (app not yet initialized)"
                    .to_string(),
            );
        }
        let global: GlobalRef = env
            .new_global_ref(&app)
            .map_err(|e| format!("failed to hold the application context: {e}"))?;
        let raw = global.as_obj().as_raw() as *mut c_void;
        std::mem::forget(global); // keep the context alive for the process lifetime
        Ok(raw)
    }
}

fn refresh_token_entry() -> Result<VaultEntry, String> {
    // On Android the Keystore store must be installed before any entry is
    // created; desktop resolves to a no-op because this cfg is absent.
    #[cfg(target_os = "android")]
    android_keystore::ensure()?;
    VaultEntry::new(SERVICE_NAME, REFRESH_TOKEN_USER).map_err(|e| {
        format!("failed to open OS credential vault entry (service \"{SERVICE_NAME}\"): {e}")
    })
}

/// Persist the Google OAuth refresh token in the OS credential vault.
#[tauri::command]
pub fn set_refresh_token(token: String) -> Result<(), String> {
    let entry = refresh_token_entry()?;
    entry.set_password(&token).map_err(|e| {
        // Never include the token in the error: it is a long-lived secret.
        format!("failed to store refresh token in the OS credential vault: {e}")
    })
}

/// Read the persisted refresh token, or `None` when nothing is stored.
#[tauri::command]
pub fn get_refresh_token() -> Result<Option<String>, String> {
    let entry = refresh_token_entry()?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        // No stored credential is the normal "signed out" state, not an error.
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!(
            "failed to read refresh token from the OS credential vault: {e}"
        )),
    }
}

/// Delete the persisted refresh token; a missing entry is not an error.
#[tauri::command]
pub fn delete_refresh_token() -> Result<(), String> {
    let entry = refresh_token_entry()?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // Deleting a credential that is already gone is idempotent.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!(
            "failed to delete refresh token from the OS credential vault: {e}"
        )),
    }
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;

    /// Point the keyring default store at the in-memory mock store so the
    /// commands above can be exercised without touching the OS vault.
    ///
    /// The keyring v1 one-time platform store init is warmed up FIRST: on
    /// desktop it runs on the first `Entry::new` and would otherwise overwrite
    /// our mock with the real platform store (keyring-4.1.6 src/v1.rs:107-129).
    fn use_mock_store() {
        let _ = Entry::store_status();
        let store = keyring_core::mock::Store::new().expect("mock store creation");
        keyring_core::set_default_store(store);
    }

    #[test]
    fn set_then_get_roundtrips() {
        use_mock_store();
        assert_eq!(set_refresh_token("token-abc".to_string()), Ok(()));
        assert_eq!(get_refresh_token(), Ok(Some("token-abc".to_string())));
    }

    #[test]
    fn get_without_entry_returns_none() {
        use_mock_store();
        assert_eq!(get_refresh_token(), Ok(None));
    }

    #[test]
    fn delete_missing_entry_is_ok() {
        use_mock_store();
        assert_eq!(delete_refresh_token(), Ok(()));
    }

    #[test]
    fn delete_then_get_returns_none() {
        use_mock_store();
        set_refresh_token("token-xyz".to_string()).expect("set");
        assert_eq!(delete_refresh_token(), Ok(()));
        assert_eq!(get_refresh_token(), Ok(None));
    }
}
