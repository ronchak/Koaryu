    def snapshot(database):
        return json.loads(local.sql(database, SNAPSHOT_SQL))
