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
  UserPlus,
  Zap
} from "lucide-react";
import { UserButton } from "@clerk/react";

const expertCards = [
  { className: "research", index: "01", title: "Customer research", detail: "Find recurring needs" },
  { className: "analysis", index: "02", title: "Policy review", detail: "Check current guidance" },
  { className: "writing", index: "03", title: "Clear writing", detail: "Shape one response" }
];

function RoutingDemo() {
  return (
    <div className="routing-demo" aria-label="A request is shared with the right specialists, who collaborate before one answer is assembled">
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
        <span>YOUR REQUEST</span>
        <p>Use our customer feedback and return policy to suggest a clearer update.</p>
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
        <span className="answer-status"><Check size={12} strokeWidth={2.2} /> TEAM RESPONSE</span>
        <strong>One clear recommendation</strong>
        <span className="answer-lines"><i /><i /><i /></span>
      </div>
    </div>
  );
}

export default function LandingPage({ isSignedIn = false, onSignIn, onSignUp, onWorkspace }) {
  const onEnter = isSignedIn ? onWorkspace : onSignUp;
  const privacyPolicyUrl = String(import.meta.env.VITE_PRIVACY_POLICY_URL || "").trim();
  const termsOfServiceUrl = String(import.meta.env.VITE_TERMS_OF_SERVICE_URL || "").trim();
  return (
    <div className="landing-page">
      <header className="landing-header">
        <a className="landing-name" href="#top" aria-label="Virenis home">Virenis</a>
        <nav aria-label="Homepage navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#agents">Your team</a>
          <a href="#knowledge">Knowledge</a>
        </nav>
        <div className="landing-auth-actions">
          {isSignedIn ? (
            <>
              <button className="landing-login" type="button" onClick={onWorkspace}>Open my team <ArrowUpRight size={15} /></button>
              <UserButton afterSignOutUrl="/" />
            </>
          ) : (
            <>
              <button className="landing-signin" type="button" onClick={onSignIn}>Sign in</button>
              <button className="landing-login" type="button" onClick={onSignUp}>Build my team <ArrowUpRight size={15} /></button>
            </>
          )}
        </div>
      </header>

      <main id="top">
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="hero-copy">
            <p className="landing-kicker"><span /> Your AI team, built around your work</p>
            <h1 id="landing-title">Build the team<br />your work<br /><em>deserves.</em></h1>
            <p className="hero-intro">
              Describe what you need. Virenis brings in specialists with clear roles, lets them collaborate, and returns one answer you can use. You set the goal and stay in control of the team.
            </p>
            <div className="hero-actions">
              <button className="landing-primary" type="button" onClick={onEnter}>
                {isSignedIn ? "Open my team" : "Build my team"} <ArrowRight size={16} />
              </button>
              <a className="landing-secondary" href="#how-it-works">See a team in action</a>
            </div>
            <div className="hero-meta" aria-label="Team benefits">
              <span>Your roles · your rules</span>
              <span>One request in · one answer out</span>
            </div>
          </div>
          <div className="hero-visual">
            <div className="visual-label"><span>YOUR TEAM AT WORK</span><i>Specialists collaborating</i></div>
            <RoutingDemo />
          </div>
        </section>

        <section className="principle-strip" aria-label="Virenis principles">
          <span>Describe the outcome</span>
          <i />
          <span>Let specialists collaborate</span>
          <i />
          <span>Stay in control of the answer</span>
        </section>

        <section className="landing-section process-section" id="how-it-works" aria-labelledby="process-title">
          <div className="section-number">01 / HOW IT WORKS</div>
          <div className="section-lead">
            <h2 id="process-title">You set the goal. Your team handles the handoffs.</h2>
            <p>
              Work that looks like one request often needs several kinds of judgment. Virenis makes that teamwork visible, so you can understand who is helping, what each specialist owns, and how the final answer comes together.
            </p>
          </div>
          <div className="process-list">
            <article>
              <span>01</span><GitBranch size={20} strokeWidth={1.6} />
              <h3>Describe the result</h3>
              <p>Say what you want in everyday language. Add the constraints that matter, just as you would when briefing a trusted colleague.</p>
            </article>
            <article>
              <span>02</span><Route size={20} strokeWidth={1.6} />
              <h3>Meet the specialists</h3>
              <p>Virenis matches each part of the request to a teammate with the right role, knowledge, and permissions. You can review or change the team.</p>
            </article>
            <article>
              <span>03</span><Zap size={20} strokeWidth={1.6} />
              <h3>Let them collaborate</h3>
              <p>Teammates work side by side or pass useful context forward when one step depends on another. Their responsibilities stay clear.</p>
            </article>
            <article>
              <span>04</span><Check size={20} strokeWidth={1.6} />
              <h3>Use one clear answer</h3>
              <p>The useful contributions are brought together into a coherent response, with important sources, limits, and next steps kept visible.</p>
            </article>
          </div>
        </section>

        <section className="landing-section agent-section" id="agents" aria-labelledby="agents-title">
          <div className="section-number">02 / YOUR TEAM</div>
          <div className="section-lead wide-lead">
            <h2 id="agents-title">Every specialist has a role you can understand—and control.</h2>
            <p>
              Building a team should feel like assigning responsibility, not configuring infrastructure. Name the role, explain good work, choose what it may use, and decide who can hand work to whom.
            </p>
          </div>
          <div className="agent-feature-grid">
            <article className="feature-card feature-card-large">
              <div className="feature-icon"><Bot size={21} strokeWidth={1.6} /></div>
              <span>BUILD YOUR TEAM</span>
              <h3>Name the role. Set the standards. Put it to work.</h3>
              <p>
                Start with what this teammate is responsible for and what a useful result looks like. Virenis turns those choices into a reusable role while keeping the setup understandable.
              </p>
              <ul>
                <li><Check size={14} /> Give every teammate a clear purpose</li>
                <li><Check size={14} /> Approve tools only when they are needed</li>
                <li><Check size={14} /> Choose how teammates share work</li>
              </ul>
            </article>
            <article className="feature-card">
              <div className="feature-icon"><UserPlus size={21} strokeWidth={1.6} /></div>
              <span>YOUR TEAM FIRST</span>
              <h3>Start with the teammates you already trust.</h3>
              <p>Virenis looks at your own team first. When a role is missing, you can review the suggested specialist before it joins the work.</p>
            </article>
            <article className="feature-card">
              <div className="feature-icon"><RefreshCw size={21} strokeWidth={1.6} /></div>
              <span>REUSABLE TEAMWORK</span>
              <h3>Keep the team. Change the assignment.</h3>
              <p>Save roles, knowledge, and handoffs as a team you can use again. Adjust one teammate without rebuilding the way everyone works together.</p>
            </article>
          </div>
        </section>

        <section className="landing-section knowledge-section" id="knowledge" aria-labelledby="knowledge-title">
          <div className="knowledge-copy">
            <div className="section-number">03 / KNOWLEDGE</div>
            <h2 id="knowledge-title">Give each teammate the context it needs—not everything you have.</h2>
            <p>
              Add a PDF or Markdown file while creating a teammate, or reuse knowledge already in your workspace. Attach it to the role that needs it and replace it when the source changes.
            </p>
            <p>
              Keeping guidance separate from the role makes both easier to understand. It also helps you review the sources behind an answer instead of treating every confident sentence the same way.
            </p>
            <button className="landing-text-link" type="button" onClick={onEnter}>Add knowledge to my team <ArrowRight size={15} /></button>
          </div>
          <div className="knowledge-visual" aria-label="Customer research and an approved policy connected to a reusable teammate">
            <div className="knowledge-file first-file"><FileText size={19} /><span><strong>Customer interviews.pdf</strong><small>Research notes</small></span><Check size={15} /></div>
            <div className="knowledge-file second-file"><BookOpen size={19} /><span><strong>Return policy.md</strong><small>Approved guidance</small></span><Check size={15} /></div>
            <div className="knowledge-connector" aria-hidden="true"><i /><span>RELEVANT CONTEXT</span><i /></div>
            <div className="knowledge-agent"><Bot size={22} /><span><small>TEAMMATE</small><strong>Policy guide</strong></span><em>Ready</em></div>
          </div>
        </section>

        <section className="landing-section trust-section" aria-labelledby="trust-title">
          <div className="section-number">04 / STAY IN CONTROL</div>
          <div className="section-lead">
            <h2 id="trust-title">See why each teammate joined the work.</h2>
            <p>
              The run view shows which specialists were selected, the task each received, and how their work contributed to the response. Review the team, refine a role, and reuse what worked the next time.
            </p>
          </div>
          <div className="tracking-preview">
            <div><span className="tracking-dot" /><p><strong>Your brief</strong><small>Use customer interviews and the current return policy only.</small></p></div>
            <div><span className="tracking-check"><Check size={13} /></span><p><strong>Your team’s response</strong><small>A clearer policy draft with sources, open questions, and next steps.</small></p><em>Ready to review</em></div>
          </div>
        </section>

        <section className="landing-cta">
          <p>VIRENIS / YOUR TEAM, YOUR WAY</p>
          <h2>Build the team around your best work.</h2>
          <button className="landing-primary inverse" type="button" onClick={onEnter}>{isSignedIn ? "Open my team" : "Build your team"} <ArrowRight size={16} /></button>
        </section>
      </main>

      <footer className="landing-footer">
        <span>Virenis</span>
        <div className="landing-footer-meta">
          <p>The right specialists. One clear answer.</p>
          {(privacyPolicyUrl || termsOfServiceUrl) && (
            <nav aria-label="Legal information">
              {privacyPolicyUrl && <a href={privacyPolicyUrl}>Privacy</a>}
              {termsOfServiceUrl && <a href={termsOfServiceUrl}>Terms</a>}
            </nav>
          )}
        </div>
        <button type="button" onClick={onEnter}>{isSignedIn ? "Open my team" : "Build my team"} <ArrowUpRight size={14} /></button>
      </footer>
    </div>
  );
}
