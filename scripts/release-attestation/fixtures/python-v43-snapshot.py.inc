    def snapshot(database):
        fields = [f"'{table}',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)->>'id',"
                  f"to_jsonb(t)::TEXT COLLATE \"C\"),'[]'::JSONB) FROM {table} t)" for table in TABLES]
        return json.loads(local.sql(database, "SET TIME ZONE 'UTC'; SELECT jsonb_build_object(" + ",".join(fields) + ");"))
