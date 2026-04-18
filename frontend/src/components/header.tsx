interface HeaderProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
}

export function Header({ title, description, children }: HeaderProps) {
  return (
    <header className="flex items-center justify-between px-8 py-5 border-b border-border">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">{title}</h1>
        {description && (
          <p className="text-sm text-text-secondary mt-0.5">{description}</p>
        )}
      </div>
      {children && (
        <div className="flex items-center gap-2">{children}</div>
      )}
    </header>
  );
}
