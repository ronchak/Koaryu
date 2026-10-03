            local.sql(database, contract_bytes.decode("utf8"))
            require(contract_path.read_bytes() == contract_bytes,
                    "Subscription fact contract changed during verification")
            require(snapshot(database) == before, "Subscription fact proof changed retained rows")
            outcomes["subscription_terms_contract_sha256"] = hashlib.sha256(contract_bytes).hexdigest()
