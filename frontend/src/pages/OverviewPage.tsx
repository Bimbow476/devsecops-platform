import { usePolling } from '../hooks/usePolling';
import { api } from '../api/client';
import ServiceCard from '../components/ServiceCard';

export default function OverviewPage() {
  const { data, error, loading, retries } = usePolling(api.status, 5000);

  const allDown = data !== null && data.length > 0 && data.every((s) => s.status === 'down');

  return (
    <div>
      <header className="page-head">
        <h1>Стан платформи</h1>
        <p className="muted">Автооновлення кожні 5 секунд · стійке опитування з backoff</p>
      </header>

      {error && (
        <div className="banner error">
          ⚠️ Втрачено з'єднання з платформою — повторна спроба через backoff (спроба {retries})
        </div>
      )}
      {allDown && !error && (
        <div className="banner error">Усі сервіси недоступні</div>
      )}
      {loading && !data && <div className="banner">Завантаження стану…</div>}

      {data && (
        <div className="cards">
          {data.map((service) => (
            <ServiceCard key={service.name} service={service} />
          ))}
        </div>
      )}

      {data && (
        <section className="info-block">
          <h2>Архітектура платформи</h2>
          <p>
            React-дашборд звертається до <b>API Gateway</b> (<code>/api/status</code>), який
            агрегує health-перевірки мікросервісів <b>metrics</b> та <b>data</b>. Якщо сервіс
            недоступний — дашборд не падає, а показує статус <b>DOWN</b> і продовжує опитування
            з експоненційним збільшенням інтервалу.
          </p>
        </section>
      )}
    </div>
  );
}