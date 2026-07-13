import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Bot,
  Check,
  FileText,
  GitBranch,
  RefreshCw,
  Route,
  Upload,
  Zap
} from "lucide-react";

const expertCards = [
  { className: "research", index: "01", title: "Research", detail: "Find the evidence" },
  { className: "analysis", index: "02", title: "Analysis", detail: "Test the assumptions" },
  { className: "writing", index: "03", title: "Writing", detail: "Shape the response" }
];

function RoutingDemo() {
  return (
    <div className="routing-demo" aria-label="A request is divided and routed to three specialist agents before one answer is assembled">
      <div className="demo-grid" aria-hidden="true" />
      <svg className="routing-lines" viewBox="0 0 640 430" preserveAspectRatio="none" role="presentation" aria-hidden="true">
        <path className="route-line route-line-one" d="M320 104 C320 146 112 139 112 196" pathLength="1" />
        <path className="route-line route-line-two" d="M320 104 L320 196" pathLength="1" />
        <path className="route-line route-line-three" d="M320 104 C320 146 528 139 528 196" pathLength="1" />
        <path className="route-line route-line-four" d="M112 286 C112 326 320 313 320 356" pathLength="1" />
        <path className="route-line route-line-five" d="M320 286 L320 356" pathLength="1" />
        <path className="route-line route-line-six" d="M528 286 C528 326 320 313 320 356" pathLength="1" />
        <circle className="route-signal signal-one" r="3.5">
          <animateMotion dur="3.6s" begin="0s" repeatCount="indefinite" path="M320 104 C320 146 112 139 112 196" />
        </circle>
        <circle className="route-signal signal-two" r="3.5">
          <animateMotion dur="3.6s" begin="0.7s" repeatCount="indefinite" path="M320 104 L320 196" />
        </circle>
        <circle className="route-signal signal-three" r="3.5">
          <animateMotion dur="3.6s" begin="1.4s" repeatCount="indefinite" path="M320 104 C320 146 528 139 528 196" />
        </circle>
      </svg>

      <div className="demo-prompt">
        <span>INPUT</span>
        <p>Assess this launch, find the risks, and prepare a clear decision brief.</p>
        <i aria-hidden="true" />
      </div>

      <div className="demo-experts">
        {expertCards.map((expert) => (
          <div className={`demo-expert ${expert.className}`} key={expert.title}>
            <span>{expert.index}</span>
            <Bot size={17} strokeWidth={1.7} />
            <strong>{expert.title}</strong>
            <small>{expert.detail}</small>
          </div>
        ))}
      </div>

      <div className="demo-answer">
        <span className="answer-status"><Check size={12} strokeWidth={2.2} /> COMBINED</span>
        <strong>One clear answer</strong>
        <span className="answer-lines"><i /><i /><i /></span>
      </div>
    </div>
  );
}

export default function LandingPage({ onEnter }) {
  return (
    <div className="landing-page">
      <header className="landing-header">
        <a className="landing-name" href="#top" aria-label="Virenis home">Virenis</a>
        <nav aria-label="Homepage navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#agents">Agents</a>
          <a href="#knowledge">Knowledge</a>
        </nav>
        <button className="landing-login" type="button" onClick={onEnter}>
          Open workspace <ArrowUpRight size={15} />
        </button>
      </header>

      <main id="top">
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="hero-copy">
            <p className="landing-kicker"><span /> A system for expert work</p>
            <h1 id="landing-title">One prompt.<br />The right experts.<br /><em>One clear answer.</em></h1>
            <p className="hero-intro">
              Virenis turns a complex request into focused tasks, sends each task to the agent best suited to it, and brings the work back together. You ask once. The system handles the division of labor.
            </p>
            <div className="hero-actions">
              <button className="landing-primary" type="button" onClick={onEnter}>
                Start working <ArrowRight size={16} />
              </button>
              <a className="landing-secondary" href="#how-it-works">See how it works</a>
            </div>
            <div className="hero-meta" aria-label="Article details">
              <span>3 minute read</span>
              <span>Built for changing knowledge</span>
            </div>
          </div>
          <div className="hero-visual">
            <div className="visual-label"><span>LIVE WORKFLOW</span><i>03 agents active</i></div>
            <RoutingDemo />
          </div>
        </section>

        <section className="principle-strip" aria-label="Virenis principles">
          <span>Divide the work</span>
          <i />
          <span>Use the right knowledge</span>
          <i />
          <span>Change specialists without rebuilding</span>
        </section>

        <section className="landing-section process-section" id="how-it-works" aria-labelledby="process-title">
          <div className="section-number">01 / HOW IT WORKS</div>
          <div className="section-lead">
            <h2 id="process-title">A complex request is rarely one job.</h2>
            <p>
              A good answer may require research, calculation, policy review, source checking, and careful writing. Asking one general system to do all of that in a single pass hides the work and makes it harder to improve. Virenis makes the structure explicit.
            </p>
          </div>
          <div className="process-list">
            <article>
              <span>01</span><GitBranch size={20} strokeWidth={1.6} />
              <h3>Break down</h3>
              <p>The request is read for intent, constraints, and dependencies, then divided into focused tasks that can be handled independently or in sequence.</p>
            </article>
            <article>
              <span>02</span><Route size={20} strokeWidth={1.6} />
              <h3>Route</h3>
              <p>Each task goes only to an authorized expert with the relevant instructions, tools, knowledge, and role in the workflow.</p>
            </article>
            <article>
              <span>03</span><Zap size={20} strokeWidth={1.6} />
              <h3>Work in parallel</h3>
              <p>Independent experts can work at the same time. When one task depends on another, the verified output is handed forward deliberately.</p>
            </article>
            <article>
              <span>04</span><Check size={20} strokeWidth={1.6} />
              <h3>Bring it together</h3>
              <p>Virenis assembles the useful contributions into one coherent response, preserving source references and important limitations.</p>
            </article>
          </div>
        </section>

        <section className="landing-section agent-section" id="agents" aria-labelledby="agents-title">
          <div className="section-number">02 / AGENTS</div>
          <div className="section-lead wide-lead">
            <h2 id="agents-title">Create a specialist in minutes. Change it the moment the work changes.</h2>
            <p>
              An agent should feel like a clear job description, not infrastructure. Give it a name, explain what it does, choose the tools it may use, connect it to other agents, and add the knowledge it needs. It is then ready to call directly or to be selected for a matching task.
            </p>
          </div>
          <div className="agent-feature-grid">
            <article className="feature-card feature-card-large">
              <div className="feature-icon"><Bot size={21} strokeWidth={1.6} /></div>
              <span>INSTANT AGENTS</span>
              <h3>Describe the role. Use it now.</h3>
              <p>
                Start with a simple behavior layer, define how the agent should respond, and decide which inputs and outputs it shares. The complicated contract stays underneath; the creator sees understandable choices.
              </p>
              <ul>
                <li><Check size={14} /> Plain-language setup</li>
                <li><Check size={14} /> Controlled tools and handoffs</li>
                <li><Check size={14} /> Direct use with an @ mention</li>
              </ul>
            </article>
            <article className="feature-card">
              <div className="feature-icon"><Upload size={21} strokeWidth={1.6} /></div>
              <span>MODEL APIS</span>
              <h3>Bring the model you trust.</h3>
              <p>Connect an approved model API to an agent and give it the role, tools, and knowledge the work requires. Providers stay replaceable while the agent contract remains stable.</p>
            </article>
            <article className="feature-card">
              <div className="feature-icon"><RefreshCw size={21} strokeWidth={1.6} /></div>
              <span>PORTABLE WORKFLOWS</span>
              <h3>Switch providers, not the workflow.</h3>
              <p>Move an agent to another API model while preserving its role, resources, permissions, and connections. The team keeps working without being rebuilt around one provider.</p>
            </article>
          </div>
        </section>

        <section className="landing-section knowledge-section" id="knowledge" aria-labelledby="knowledge-title">
          <div className="knowledge-copy">
            <div className="section-number">03 / KNOWLEDGE</div>
            <h2 id="knowledge-title">Give agents a source of truth without creating another agent.</h2>
            <p>
              Upload a PDF or Markdown file while creating an agent, or attach knowledge that is already in your workspace. The resource stays available to that role and can be replaced when the source changes. This keeps instructions separate from evidence and makes updates far less disruptive.
            </p>
            <p>
              Sources remain visible with the answer they support. Instead of burying retrieval behind a confident paragraph, Virenis keeps the relationship between a claim and its supporting material inspectable.
            </p>
            <button className="landing-text-link" type="button" onClick={onEnter}>Create an agent <ArrowRight size={15} /></button>
          </div>
          <div className="knowledge-visual" aria-label="A PDF and Markdown file connected to a reusable agent">
            <div className="knowledge-file first-file"><FileText size={19} /><span><strong>Market brief.pdf</strong><small>24 indexed sections</small></span><Check size={15} /></div>
            <div className="knowledge-file second-file"><BookOpen size={19} /><span><strong>Operating rules.md</strong><small>8 indexed sections</small></span><Check size={15} /></div>
            <div className="knowledge-connector" aria-hidden="true"><i /><span>VERIFIED CONTEXT</span><i /></div>
            <div className="knowledge-agent"><Bot size={22} /><span><small>AGENT</small><strong>Launch analyst</strong></span><em>Ready</em></div>
          </div>
        </section>

        <section className="landing-section trust-section" aria-labelledby="trust-title">
          <div className="section-number">04 / FOLLOW THE RESULT</div>
          <div className="section-lead">
            <h2 id="trust-title">Useful work should get easier to evaluate over time.</h2>
            <p>
              When an answer contains a measurable claim, you can choose what to check, when to check it, and where the result will come from. Virenis records what happened in plain language. Verified results can help choose between equally relevant agents later, while unverified notes remain personal tracking—not manufactured proof.
            </p>
          </div>
          <div className="tracking-preview">
            <div><span className="tracking-dot" /><p><strong>Claim to check</strong><small>Trial conversion will exceed 12% by September 30.</small></p></div>
            <div><span className="tracking-check"><Check size={13} /></span><p><strong>Result recorded</strong><small>13.4% · Verified from the analytics report</small></p><em>Complete</em></div>
          </div>
        </section>

        <section className="landing-cta">
          <p>VIRENIS / EXPERT WORK, COMPOSED</p>
          <h2>Start with one request.</h2>
          <button className="landing-primary inverse" type="button" onClick={onEnter}>Open the workspace <ArrowRight size={16} /></button>
        </section>
      </main>

      <footer className="landing-footer">
        <span>Virenis</span>
        <p>Complex work, divided clearly.</p>
        <button type="button" onClick={onEnter}>Workspace <ArrowUpRight size={14} /></button>
      </footer>
    </div>
  );
}
