import SearchForm from './components/SearchForm.jsx';
import ProgressPanel from './components/ProgressPanel.jsx';
import ResultsList from './components/ResultsList.jsx';
import { useSearchJob } from './hooks/useSearchJob.js';
import { useServerConfig } from './hooks/useServerConfig.js';

export default function App() {
  const config = useServerConfig();
  const job = useSearchJob();

  return (
    <main className="app">
      <header className="app-header">
        <h1>WebSiteWordFinder</h1>
        <p className="muted">
          Enter a website and a word or phrase. Every page of the site is scanned — following links and sitemaps — and the pages that contain it are listed as they are found.
        </p>
      </header>

      <SearchForm config={config} disabled={job.isRunning} submitError={job.submitError} onSubmit={job.start} />

      {job.status !== 'idle' && (
        <>
          <ProgressPanel
            status={job.status}
            progress={job.progress}
            input={job.input}
            resolvedUrl={job.resolvedUrl}
            sitemap={job.sitemap}
            siteSearch={job.siteSearch}
            error={job.error}
            stoppedBy={job.stoppedBy}
            stopping={job.stopping}
            connectionLost={job.connectionLost}
            onStop={job.stop}
          />
          <ResultsList results={job.results} pageErrors={job.pageErrors} status={job.status} phrase={job.input?.phrase} />
        </>
      )}
    </main>
  );
}
