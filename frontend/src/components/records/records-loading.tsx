import { Header } from "@/components/header";
import styles from "./records-loading.module.css";

type RecordsLoadingVariant = "roster" | "folio" | "import" | "belt";

type RecordsLoadingProps = {
  description: string;
  title: string;
  variant: RecordsLoadingVariant;
};

function SkeletonBar({ short = false }: { short?: boolean }) {
  return <span aria-hidden="true" className={short ? styles.barShort : styles.bar} />;
}

function RosterLoading() {
  return (
    <div className={styles.roster}>
      <div className={styles.intro} aria-hidden="true">
        <SkeletonBar short />
        <span className={styles.titleBar} />
        <SkeletonBar />
      </div>
      <div className={styles.controls} aria-hidden="true">
        <span className={styles.searchControl} />
        <span className={styles.control} />
        <span className={styles.control} />
      </div>
      <div className={styles.table} aria-hidden="true">
        {Array.from({ length: 7 }).map((_, row) => (
          <div key={row} className={row === 0 ? styles.tableHeader : styles.tableRow}>
            {Array.from({ length: 6 }).map((__, column) => (
              <SkeletonBar key={column} short={column > 2} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function FolioLoading() {
  return (
    <div className={styles.folio}>
      <div className={styles.intro} aria-hidden="true">
        <SkeletonBar short />
        <span className={styles.titleBar} />
        <SkeletonBar />
      </div>
      <div className={styles.folioGrid} aria-hidden="true">
        <aside className={styles.identityLeaf}>
          <span className={styles.avatar} />
          <span className={styles.titleBar} />
          {Array.from({ length: 5 }).map((_, index) => <SkeletonBar key={index} short={index % 2 === 0} />)}
        </aside>
        <div className={styles.leafStack}>
          {Array.from({ length: 3 }).map((_, leaf) => (
            <section key={leaf} className={styles.leaf}>
              <SkeletonBar short />
              <span className={styles.titleBar} />
              {Array.from({ length: 3 }).map((__, row) => <SkeletonBar key={row} short={row === 2} />)}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function ImportLoading() {
  return (
    <div className={styles.importSheet} aria-hidden="true">
      <aside className={styles.importIndex}>
        <span className={styles.titleBar} />
        <SkeletonBar />
        <div className={styles.stageStack}>
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className={styles.stage}><span>{String(index + 1).padStart(2, "0")}</span><SkeletonBar /></div>
          ))}
        </div>
      </aside>
      <section className={styles.worksheet}>
        <div className={styles.dropZone}><span className={styles.uploadMark} /><span className={styles.titleBar} /><SkeletonBar /></div>
        <div className={styles.mappingRows}>
          {Array.from({ length: 5 }).map((_, row) => (
            <div key={row} className={styles.mappingRow}><SkeletonBar /><span className={styles.control} /></div>
          ))}
        </div>
      </section>
    </div>
  );
}

function BeltLoading() {
  return (
    <div className={styles.belt}>
      <div className={styles.intro} aria-hidden="true">
        <SkeletonBar short />
        <span className={styles.titleBar} />
        <SkeletonBar />
      </div>
      <div className={styles.controls} aria-hidden="true">
        <span className={styles.tabControl} />
        <span className={styles.tabControl} />
        <span className={styles.programControl} />
      </div>
      <div className={styles.beltGrid} aria-hidden="true">
        <div className={styles.table}>
          {Array.from({ length: 7 }).map((_, row) => (
            <div key={row} className={row === 0 ? styles.tableHeader : styles.tableRow}>
              {Array.from({ length: 5 }).map((__, column) => <SkeletonBar key={column} short={column > 2} />)}
            </div>
          ))}
        </div>
        <div className={styles.rankRail}>
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className={styles.rankStop}><span>{String(index + 1).padStart(2, "0")}</span><SkeletonBar short /></div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function RecordsLoading({ description, title, variant }: RecordsLoadingProps) {
  return (
    <div className={styles.root}>
      <Header title={title} description={description} />
      <p className="sr-only" role="status" aria-live="polite">{description}</p>
      {variant === "roster" ? <RosterLoading /> : null}
      {variant === "folio" ? <FolioLoading /> : null}
      {variant === "import" ? <ImportLoading /> : null}
      {variant === "belt" ? <BeltLoading /> : null}
    </div>
  );
}
