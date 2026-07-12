"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import {
  CSV_IMPORT_MAX_BYTES,
  areCsvImportKeyInputsEqual,
  buildStableImportKey,
  formatCsvImportFileSizeLimit,
  hashCsvImportFile,
  type CsvImportKeyInput,
} from "@/lib/csv-import";
import { splitCsvImportFullName } from "@/lib/csv-import-mapping";
import {
  DEFAULT_IMPORT_OPTIONS,
  autoMap,
  buildPreviewValidationResult,
  getCsvImportFileRejection,
  getStudentImportErrorMessage,
  mockParseCSV,
  type ActiveStudentImportOperation,
  type StudentImportStage,
} from "@/lib/student-import-page-model";
import type {
  ConfigStoreContextValue,
  StudentsStoreContextValue,
} from "@/lib/store-contexts";
import { hasStaffPermission } from "@/lib/staff-permissions";
import type { CsvImportOptions, CsvImportResult, CsvParseResponse } from "@/types";

type StudentImportPageControllerOptions = {
  config: Pick<ConfigStoreContextValue, "currentRole" | "isPreviewMode" | "token">;
  studentsStore: Pick<StudentsStoreContextValue, "importStudents">;
};

export function useStudentImportPageController({
  config,
  studentsStore,
}: StudentImportPageControllerOptions) {
  const router = useRouter();
  const { isPreviewMode, token } = config;
  const canManageRoster = hasStaffPermission(config.currentRole, "manage_roster_bulk");
  const { importStudents } = studentsStore;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileRequestRef = useRef(0);
  const validationRequestRef = useRef(0);
  const importRequestRef = useRef(0);

  const [stage, setStage] = useState<StudentImportStage>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [fileContentHash, setFileContentHash] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [validationState, setValidationState] = useState<{
    input: CsvImportKeyInput;
    result: CsvImportResult;
  } | null>(null);
  const [importResult, setImportResult] = useState<CsvImportResult | null>(null);
  const [importOptions, setImportOptions] = useState<CsvImportOptions>(DEFAULT_IMPORT_OPTIONS);
  const [submittedImportOptions, setSubmittedImportOptions] = useState<CsvImportOptions>(DEFAULT_IMPORT_OPTIONS);
  const [importKeyState, setImportKeyState] = useState<{
    input: CsvImportKeyInput;
    key: string | null;
    error: string | null;
  } | null>(null);
  const [activeOperation, setActiveOperation] = useState<ActiveStudentImportOperation>(null);
  const [dragOver, setDragOver] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isLoading = activeOperation !== null;
  const isImporting = activeOperation === "import";

  function invalidateImportRequests() {
    fileRequestRef.current += 1;
    validationRequestRef.current += 1;
    importRequestRef.current += 1;
  }

  function resetImportState() {
    invalidateImportRequests();
    setStage("upload");
    setFile(null);
    setFileContentHash(null);
    setHeaders([]);
    setRows([]);
    setRowCount(0);
    setMapping({});
    setValidationState(null);
    setImportResult(null);
    setImportOptions(DEFAULT_IMPORT_OPTIONS);
    setSubmittedImportOptions(DEFAULT_IMPORT_OPTIONS);
    setImportKeyState(null);
    setActiveOperation(null);
    setDragOver(false);
    setErrorMessage(null);
  }

  const importKeyInput = useMemo<CsvImportKeyInput | null>(() => {
    if (!file || !fileContentHash) {
      return null;
    }

    return {
      rowCount,
      mapping,
      options: importOptions,
      contentHash: fileContentHash,
    };
  }, [file, fileContentHash, importOptions, mapping, rowCount]);
  const activeImportKey = areCsvImportKeyInputsEqual(importKeyState?.input, importKeyInput)
    ? importKeyState?.key ?? null
    : null;
  const importKeyError = areCsvImportKeyInputsEqual(importKeyState?.input, importKeyInput)
    ? importKeyState?.error ?? null
    : null;
  const validationResult = areCsvImportKeyInputsEqual(validationState?.input, importKeyInput)
    ? validationState?.result ?? null
    : null;

  useEffect(() => {
    if (!importKeyInput) {
      return;
    }

    let canceled = false;

    void buildStableImportKey(importKeyInput).then((nextImportKey) => {
      if (!canceled) {
        setImportKeyState({ input: importKeyInput, key: nextImportKey, error: null });
      }
    }).catch((error) => {
      if (!canceled) {
        setImportKeyState({
          input: importKeyInput,
          key: null,
          error: error instanceof Error
            ? error.message
            : "Koaryu could not prepare a duplicate-safe import key.",
        });
      }
    });

    return () => {
      canceled = true;
    };
  }, [importKeyInput]);

  async function handleFile(nextFile: File) {
    const requestId = fileRequestRef.current += 1;
    validationRequestRef.current += 1;
    importRequestRef.current += 1;

    const fileRejection = getCsvImportFileRejection(nextFile, {
      maxBytes: CSV_IMPORT_MAX_BYTES,
      formattedLimit: formatCsvImportFileSizeLimit(),
    });
    if (fileRejection) {
      setActiveOperation(null);
      setErrorMessage(fileRejection);
      return;
    }

    setActiveOperation("file");
    setErrorMessage(null);
    setValidationState(null);
    setImportResult(null);
    setFileContentHash(null);
    setImportKeyState(null);

    try {
      const nextContentHash = await hashCsvImportFile(nextFile);
      if (fileRequestRef.current !== requestId) {
        return;
      }

      if (isPreviewMode) {
        const parsed = await mockParseCSV(nextFile);
        if (fileRequestRef.current !== requestId) {
          return;
        }
        setFile(nextFile);
        setFileContentHash(nextContentHash);
        setHeaders(parsed.headers);
        setRows(parsed.rows);
        setRowCount(parsed.rows.length);
        setMapping(autoMap(parsed.headers));
      } else {
        if (!token) {
          throw new Error("You need to be signed in before importing students.");
        }

        const formData = new FormData();
        formData.append("file", nextFile);

        const parsed = await api.postForm<CsvParseResponse>(
          "/students/import/parse",
          formData,
          token,
          {
            timeoutMs: 30000,
            timeoutMessage: "Parsing this CSV is taking longer than expected. Please try again in a moment.",
          }
        );
        if (fileRequestRef.current !== requestId) {
          return;
        }

        setFile(nextFile);
        setFileContentHash(nextContentHash);
        setHeaders(parsed.headers);
        setRows(parsed.preview_rows);
        setRowCount(parsed.total_rows);
        setMapping(parsed.auto_mapping);
      }
      setStage("map");
    } catch (error) {
      if (fileRequestRef.current !== requestId) {
        return;
      }
      resetImportState();
      setErrorMessage(getStudentImportErrorMessage(error));
    } finally {
      if (fileRequestRef.current === requestId) {
        setActiveOperation(null);
      }
    }
  }

  async function handleValidate(nextOptions: CsvImportOptions = importOptions) {
    if (isImporting) {
      return;
    }
    const requestId = validationRequestRef.current += 1;
    const requestFile = file;
    const requestRows = rows;
    const requestMapping = mapping;
    const requestFileContentHash = fileContentHash;
    const requestRowCount = rowCount;
    const requestStage = stage;
    const requestInput = requestFileContentHash
      ? {
        rowCount: requestRowCount,
        mapping: requestMapping,
        options: nextOptions,
        contentHash: requestFileContentHash,
      }
      : null;
    setActiveOperation("validation");
    setErrorMessage(null);
    setValidationState(null);
    setImportResult(null);

    try {
      if (!requestFile || !requestInput) {
        throw new Error("Choose a CSV file before validating.");
      }

      if (isPreviewMode) {
        const result = buildPreviewValidationResult(requestRows, requestMapping, nextOptions, splitCsvImportFullName);
        if (validationRequestRef.current !== requestId) {
          return;
        }
        setValidationState({ input: requestInput, result });
      } else {
        if (!token) {
          throw new Error("You need to be signed in before importing students.");
        }

        const formData = new FormData();
        formData.append("file", requestFile);
        formData.append("payload", JSON.stringify({
          mapping: requestMapping,
          options: nextOptions,
        }));

        const result = await api.postForm<CsvImportResult>(
          "/students/import/validate",
          formData,
          token,
          {
            timeoutMs: 30000,
            timeoutMessage: "Validation is taking longer than expected. Please wait a moment and try again.",
          }
        );

        if (validationRequestRef.current !== requestId) {
          return;
        }
        setValidationState({ input: requestInput, result });
      }

      setStage("preview");
    } catch (error) {
      if (validationRequestRef.current !== requestId) {
        return;
      }
      setErrorMessage(getStudentImportErrorMessage(error));
      if (requestStage === "preview") {
        setStage("map");
      }
    } finally {
      if (validationRequestRef.current === requestId) {
        setActiveOperation(null);
      }
    }
  }

  async function handleImport() {
    if (!canManageRoster || activeOperation !== null) {
      return;
    }
    const requestFile = file;
    const requestRows = rows;
    const requestMapping = mapping;
    const requestOptions = importOptions;
    const requestImportKey = activeImportKey;
    const requestValidationResult = validationResult;

    if (!requestFile) {
      setErrorMessage("Choose a CSV file before importing.");
      return;
    }

    if (!requestImportKey) {
      setErrorMessage(importKeyError || "Koaryu is still preparing this file for a duplicate-safe import. Try again in a moment.");
      return;
    }
    if (!requestValidationResult) {
      setErrorMessage("Validate this CSV before importing.");
      return;
    }

    const requestId = importRequestRef.current += 1;
    setActiveOperation("import");
    setErrorMessage(null);

    try {
      const result = await importStudents(requestFile, requestRows, requestMapping, requestOptions, {
        importKey: requestImportKey,
      });
      if (importRequestRef.current !== requestId) {
        return;
      }
      setSubmittedImportOptions(requestOptions);
      setImportResult(result);
      setValidationState(null);
      setImportKeyState(null);
      setStage("done");
    } catch (error) {
      if (importRequestRef.current !== requestId) {
        return;
      }
      setErrorMessage(getStudentImportErrorMessage(error));
    } finally {
      if (importRequestRef.current === requestId) {
        setActiveOperation(null);
      }
    }
  }

  async function handleOptionToggle<K extends keyof CsvImportOptions>(key: K, value: CsvImportOptions[K]) {
    if (activeOperation !== null) {
      return;
    }
    validationRequestRef.current += 1;
    const nextOptions = { ...importOptions, [key]: value };
    setValidationState(null);
    setImportResult(null);
    setImportKeyState(null);
    setImportOptions(nextOptions);
    if (stage === "preview" && file) {
      await handleValidate(nextOptions);
    }
  }

  function handleMappingChange(header: string, field: string) {
    if (activeOperation !== null) {
      return;
    }
    validationRequestRef.current += 1;
    setActiveOperation(null);
    setValidationState(null);
    setImportResult(null);
    setImportKeyState(null);
    setMapping((current) => ({ ...current, [header]: field }));
  }

  function handleBackToMapping() {
    if (isImporting) {
      return;
    }
    validationRequestRef.current += 1;
    setActiveOperation(null);
    setValidationState(null);
    setImportResult(null);
    setStage("map");
  }

  return {
    contentProps: {
      activeImportKey,
      canManageRoster,
      dragOver,
      errorMessage,
      fileInputRef,
      fileName: file?.name,
      headers,
      importKeyError,
      importOptions,
      importResult,
      isLoading,
      mapping,
      rowCount,
      rows,
      stage,
      submittedImportOptions,
      validationResult,
      onBack: () => {
        if (!isLoading) router.push("/students");
      },
      onBackToMapping: handleBackToMapping,
      onDismissError: () => setErrorMessage(null),
      onDragOverChange: setDragOver,
      onFileSelect: handleFile,
      onImport: handleImport,
      onImportAnother: resetImportState,
      onMappingChange: handleMappingChange,
      onOpenBeltTracker: (href: string) => router.push(href),
      onOptionToggle: handleOptionToggle,
      onReset: resetImportState,
      onValidate: () => handleValidate(),
      onViewStudents: () => router.push("/students"),
    },
  };
}

export type StudentImportPageController = ReturnType<typeof useStudentImportPageController>;
