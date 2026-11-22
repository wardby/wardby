//! Which environment variables a forwarded command takes from the client.

/// Variables the toolchain image owns: the client never sends them and the agent never accepts
/// them, so the image's own `PATH` and locale stay in force.
pub const IMAGE_OWNED: &[&str] = &["PATH", "LANG", "PWD", "OLDPWD", "SHLVL", "_"];

/// Whether a variable may travel from the client to the command. `WARDBY_*` never does: no
/// Wardby value reaches the toolchain. Names that the environment cannot hold are dropped.
pub fn is_forwardable(key: &str) -> bool {
    !key.is_empty()
        && !key.contains('=')
        && !key.starts_with("WARDBY_")
        && !IMAGE_OWNED.contains(&key)
}

/// The client's environment as sent to the agent.
pub fn forwarded(vars: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
    vars.into_iter()
        .filter(|(k, v)| is_forwardable(k) && !v.contains('\0'))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(k: &str, v: &str) -> (String, String) {
        (k.to_string(), v.to_string())
    }

    #[test]
    fn drops_image_owned_and_wardby_values() {
        let input = vec![
            pair("PATH", "/nowhere"),
            pair("LANG", "C"),
            pair("PWD", "/x"),
            pair("OLDPWD", "/y"),
            pair("SHLVL", "2"),
            pair("_", "/usr/bin/env"),
            pair("WARDBY_RUN_CAPABILITY", "fake"),
            pair("WARDBY_", "fake"),
            pair("PIP_INDEX_URL", "https://u:p@proxy/simple"),
            pair("HOME", "/home/wardby"),
            pair("USER", "wardby"),
            pair("NOT_WARDBY_X", "kept"),
        ];
        let kept: Vec<String> = forwarded(input).into_iter().map(|(k, _)| k).collect();
        assert_eq!(kept, vec!["PIP_INDEX_URL", "HOME", "USER", "NOT_WARDBY_X"]);
    }

    #[test]
    fn drops_names_the_environment_cannot_hold() {
        assert!(!is_forwardable(""));
        assert!(!is_forwardable("A=B"));
        assert!(forwarded(vec![pair("A", "x\0y")]).is_empty());
    }
}
