# Standard Base Qwen vs Agent-Team Qwen

Across these 2 predeclared complex scenarios, Agent-Team Qwen covered 21/24 required decision outcomes versus 16/24 for Standard Base Qwen.

> This is a two-case, same-model product showcase with a predeclared deterministic checklist. It is not the 200-case confirmatory superiority benchmark.

| Scenario | Base coverage | Team coverage | Base latency | Team latency | Team specialists |
|---|---:|---:|---:|---:|---:|
| Privacy-preserving person tracking architecture | 11/12 | 12/12 | 108.5s | 671.6s | 6 |
| Decision-ready Match-3 launch plan | 5/12 | 9/12 | 74.6s | 755.7s | 6 |

Latency and total inference tokens are disclosed separately; the team is expected to cost more compute.

## Privacy-preserving person tracking architecture

### Standard Base Qwen

This is a decision-ready architecture and implementation plan for a privacy-preserving, edge-based person-tracking system.

### 1. Executive Summary & Feasibility Check

**Verdict:** **Feasible, but tight.** The 8-week timeline for 4 engineers to build, deploy, and validate a distributed edge system with strict latency (<2s) and high availability (99.9%) is aggressive. Success depends on using mature, pre-trained models and robust infrastructure automation, not custom model training.

**Key Constraint:** 12 cameras × 15 FPS = 180 FPS per store. An NVIDIA L4 (24GB VRAM, ~100 TFLOPS FP8) can handle this, but only if inference is highly optimized (TensorRT) and the pipeline is non-blocking.

---

### 2. Decision-Ready Architecture

#### Core Principle: "Edge-First, Privacy-by-Design"
All processing happens on the NVIDIA L4. No raw video leaves the store. Only anonymized metadata (track IDs, counts, zones) is sent to the cloud/central server.

#### System Components

| Component | Technology Choice | Rationale |
| :--- | :--- | :--- |
| **Video Ingestion** | `GStreamer` + `NVIDIA Video Codec SDK` | Hardware-accelerated decoding (NVDEC) is mandatory to keep CPU load low. |
| **Object Detection** | `YOLOv8n` or `YOLOv10n` (TensorRT) | Small, fast, accurate enough for person detection. TensorRT optimization is critical for 180 FPS. |
| **Re-Identification** | `OSNet` or `FastReID` (Lightweight) | Must be lightweight. Used only for short-term track association across frames, not long-term identity. |
| **Tracking Engine** | `ByteTrack` or `BoT-SORT` | State-of-the-art for handling occlusions and short-term ID switching. |
| **Privacy Layer** | `MosaicML` or Custom Python Module | Blurs faces/bodies in any stored video. Generates UUIDv4 track IDs that expire after 24h. |
| **Event Processing** | `NATS JetStream` or `Redis Streams` | Low-latency pub/sub for alerts. Handles backpressure better than Kafka for edge. |
| **Storage (Edge)** | `MinIO` (S3-compatible) | For raw video (24h) and derived events (30d). Local SSD/NVMe required. |
| **Orchestration** | `Docker Compose` (Edge) + `Kubernetes` (Cloud) | Simpler for edge deployment. K8s for central aggregation. |
| **Monitoring** | `Prometheus` + `Grafana` | Track latency, FPS, GPU utilization, and alert health. |

#### Data Flow (Per Store)

1.  **Ingest:** RTSP streams → GStreamer → NVDEC (Hardware Decode) → Frame Buffer.
2.  **Detect:** Frame → TensorRT YOLOv8n → Bounding Boxes (Person class only).
3.  **Track:** Bounding Boxes → ByteTrack → Assign/Update Short-Lived Track IDs (UUID).
4.  **Privacy:** If face detected → Blur region in frame (for storage only, not inference).
5.  **Event Gen:** If Track ID crosses virtual line/zone → Generate Event JSON `{track_id, timestamp, zone, direction}`.
6.  **Alert:** If event matches rule (e.g., "loitering > 30s") → Publish to NATS → Push to Central API (<2s SLA).
7.  **Store:**
    *   Raw Video: Write to MinIO (24h retention).
    *   Events: Write to MinIO/PostgreSQL (30d retention).
    *   Track IDs: Expire after 24h (no long-term linkage).

---

### 3. Implementation Plan (8 Weeks, 4 Engineers)

**Team Roles:**
*   **Eng 1 (Edge/ML):** Model optimization, TensorRT, GStreamer pipeline.
*   **Eng 2 (Backend/Events):** Tracking logic, event generation, privacy module.
*   **Eng 3 (Infrastructure/DevOps):** Docker, MinIO, NATS, monitoring, deployment scripts.
*   **Eng 4 (Integration/Cloud):** Central API, alerting, dashboard, testing.

#### Week 1: Foundation & Benchmarking
*   **Goal:** Prove hardware can handle 180 FPS with <2s latency.
*   **Tasks:**
    *   Set up dev environment on one L4 box.
    *   **CRITICAL BENCHMARK:** Measure YOLOv8n TensorRT inference time at 15 FPS per camera. *Do not assume throughput.*
    *   Implement basic GStreamer pipeline with NVDEC.
    *   Define data schema for events and track IDs.
*   **Deliverable:** Benchmark report showing FPS, latency, and GPU utilization.

#### Week 2: Core Pipeline Development
*   **Goal:** End-to-end detection and tracking on one camera.
*   **Tasks:**
    *   Integrate YOLOv8n + ByteTrack.
    *   Implement short-lived UUID generation and expiration logic.
    *   Add face/body blurring for storage.
    *   Validate tracking stability (ID switches < 5% in test videos).
*   **Deliverable:** Working single-camera pipeline with privacy features.

#### Week 3: Multi-Camera & Event Logic
*   **Goal:** Scale to 12 cameras per store.
*   **Tasks:**
    *   Parallelize pipeline for 12 streams.
    *   Implement zone crossing detection (virtual lines).
    *   Define alert rules (e.g., "person in restricted zone").
    *   Integrate NATS JetStream for alert publishing.
*   **Deliverable:** 12-camera pipeline generating alerts.

#### Week 4: Storage & Retention
*   **Goal:** Implement 24h/30d retention policies.
*   **Tasks:**
    *   Deploy MinIO on edge.
    *   Implement raw video writing (24h TTL).
    *   Implement event logging (30d TTL).
    *   Add cleanup jobs to delete expired data.
*   **Deliverable:** Data retention system working.

#### Week 5: Central Aggregation & API
*   **Goal:** Cloud/central server receives alerts.
*   **Tasks:**
    *   Build central API to receive NATS messages.
    *   Implement alert forwarding (email/SMS/webhook).
    *   Build simple dashboard to view store counts/alerts.
    *   Ensure <2s end-to-end latency from camera to alert.
*   **Deliverable:** Central system receiving alerts.

#### Week 6: Pilot Deployment (Store 1)
*   **Goal:** Deploy to first store.
*   **Tasks:**
    *   Package all components into Docker images.
    *   Deploy to Store 1 L4 box.
    *   Connect 12 cameras.
    *   Monitor stability, latency, and GPU temps.
    *   Fix bugs.
*   **Deliverable:** Store 1 live.

#### Week 7: Pilot Deployment (Stores 2 & 3) & Load Testing
*   **Goal:** Deploy to remaining stores.
*   **Tasks:**
    *   Deploy to Stores 2 & 3.
    *   Run load tests: Simulate high traffic (e.g., 50 people in frame).
    *   Validate 99.9% availability (monitor uptime).
    *   Test failure scenarios: Camera disconnect, L4 reboot.
*   **Deliverable:** All 3 stores live.

#### Week 8: Validation & Handover
*   **Goal:** Final checks and documentation.
*   **Tasks:**
    *   Verify privacy compliance (no faces in stored video).
    *   Verify retention policies (data deleted after 24h/30d).
    *   Document architecture, deployment, and troubleshooting.
    *   Final benchmark report.
*   **Deliverable:** Pilot complete, ready for production.

---

### 4. Critical Assumptions & Open Decisions

#### Assumptions
1.  **Network:** Each store has a stable, low-latency network connection to the central server for alerts. Raw video never leaves the store.
2.  **Camera Quality:** RTSP streams are H.264/H.265, 1080p or lower. Higher resolutions will require more GPU power.
3.  **Lighting:** Cameras are in well-lit environments. Poor lighting will degrade detection accuracy.
4.  **Privacy Law:** Local laws allow anonymous tracking for security/operations. No biometric data is collected.
5.  **Hardware:** NVIDIA L4 boxes have sufficient NVMe storage for 24h of raw video (12 cameras × 15 FPS × 24h ≈ 1.5 TB per store). *Verify storage capacity.*

#### Open Decisions (Must Be Resolved in Week 1)
1.  **Model Choice:** YOLOv8n vs. YOLOv10n vs. RT-DETR. *Benchmark all three.*
2.  **Tracking Algorithm:** ByteTrack vs. BoT-SORT vs. DeepSORT. *Benchmark ID switch rate.*
3.  **Alert Latency Budget:** How much of the 2s is for inference, how much for network? *Define SLA breakdown.*
4.  **Failure Mode:** If L4 box fails, do we lose data? *Decide on local backup strategy.*
5.  **Central Server:** Cloud provider (AWS/GCP/Azure) or on-prem? *Decide based on compliance.*

---

### 5. What Must Be Benchmarked (Do Not Invent Numbers)

You **must** run these benchmarks on the actual NVIDIA L4 hardware with actual camera streams. Do not use published paper numbers.

1.  **Inference Throughput:**
    *   Measure FPS of YOLOv8n TensorRT on L4 for 12 concurrent streams at 15 FPS.
    *   *Target:* ≥ 180 FPS total.
    *   *Metric:* Average inference time per frame (ms).

2.  **End-to-End Latency:**
    *   Time from frame capture to alert generation.
    *   *Target:* < 2 seconds.
    *   *Metric:* P95 latency (95% of alerts must be < 2s).

3.  **Tracking Stability:**
    *   ID switch rate: How often does a person’s track ID change?
    *   *Target:* < 5% ID switches per minute per person.
    *   *Metric:* MOTA (Multi-Object Tracking Accuracy).

4.  **Storage I/O:**
    *   Can the L4’s NVMe drive write 12 streams of raw video simultaneously?
    *   *Target:* No dropped frames due to I/O bottleneck.
    *   *Metric:* Write throughput (MB/s).

5.  **GPU Utilization:**
    *   Ensure GPU is not saturated (>90%) under peak load.
    *   *Target:* < 80% average utilization.
    *   *Metric:* GPU memory and compute usage.

---

### 6. Privacy & Compliance Checklist

*   [ ] **No Facial Recognition:** Model only detects "person" class. No face embedding extraction.
*   [ ] **Blurring:** Faces and bodies are blurred in stored video.
*   [ ] **Short-Lived IDs:** Track IDs are UUIDs that expire after 24 hours. No long-term linkage.
*   [ ] **Data Retention:** Raw video deleted after 24 hours. Events deleted after 30 days.
*   [ ] **No Biometrics:** No gait analysis, no voice recognition.
*   [ ] **Consent:** Signage in stores informing customers of anonymous tracking.

---

### 7. Risks & Mitigation

| Risk | Impact | Mitigation |
| :--- | :--- | :--- |
| **GPU Overload** | Dropped frames, missed alerts | Use TensorRT optimization. Limit resolution if needed. |
| **High ID Switch Rate** | Unreliable tracking | Tune ByteTrack parameters. Use better ReID model. |
| **Network Latency** | Alerts > 2s | Optimize alert payload size. Use UDP for critical alerts. |
| **Storage Full** | Data loss | Implement aggressive cleanup. Monitor disk usage. |
| **Camera Disconnect** | Data gap | Log disconnect events. Retry connection. |

---

### 8. Next Steps

1.  **Week 1:** Set up dev environment, run benchmarks.
2.  **Week 1:** Resolve open decisions (model, tracking, central server).
3.  **Week 2:** Begin core pipeline development.

This plan is realistic if the team is experienced with edge AI and Docker. The key is to **benchmark early** and **optimize for latency** from day one.

### Agent-Team Qwen

### Architecture Decision Record

# Architecture Decision Record: Privacy-Preserving Retail Person Tracking

## 1. Context & Scope
This document defines the recommended system architecture for a distributed, edge-first computer vision system across three retail locations. The system tracks person movement to generate derived events (dwell time, zone entry) while strictly excluding facial recognition or biometric identity. The design addresses hard constraints of 15 FPS camera input, <2s alert latency, 99.9% availability, and specific data retention policies (24h raw video, 30d events).

## 2. Recommended Architecture: Edge-First Decoupled Pipeline

The recommended architecture employs a **Decoupled Edge Pipeline** pattern. Each store operates as an autonomous island with local processing, minimizing network dependency and ensuring privacy compliance by design.

### 2.1 System Boundary
* **In-Scope**: RTSP ingestion, object detection, tracking, event generation, local storage, and anonymous ID management.

### 2.2 Component Topology (Per Store)
1. **Ingestion Service**: Pulls RTSP streams from 12 cameras. Converts frames to a standardized internal format (e.g., NV12 or RGB) at 15 FPS.
2. **Detection & Tracking Engine**:
    *   Runs on the NVIDIA L4 GPU.
    *   Uses a lightweight object detection model (e.g., YOLOv8-nano or similar) to identify "person" bounding boxes.
    *   Uses a multi-object tracker (e.g., ByteTrack or OC-SORT) to assign **anonymous, short-lived track IDs**.

3. **Event Processor**:
    *   Consumes track centroids.
    *   Calculates derived events: Zone Entry, Zone Exit, Dwell Time.
    *   Generates alerts if thresholds are breached (e.g., dwell time > X seconds).
4. **Storage Layer**:
    *   **Raw Video**: Stored in a circular buffer on local NVMe/SSD. Retention: 24 hours. Overwritten automatically.
    *   **Events**: Stored in a local time-series database (e.g., TimescaleDB or InfluxDB). Retention: 30 days.
5. **API Gateway**: Exposes endpoints for event queries and alert subscriptions. Does not expose raw video or tracking metadata externally.

### 2.3 Data Flow
1. Camera -> RTSP Stream -> Ingestion Service.
2. Ingestion Service -> Frame Buffer -> Detection/Tracking Engine (GPU).
3. Detection/Tracking Engine -> Anonymous Track IDs + Bounding Boxes -> Event Processor.
4. Event Processor -> Derived Events -> Event Store (30d).
5. Ingestion Service -> Raw Video -> Video Store (24h).
6. Event Processor -> Alerts -> API Gateway -> External Consumers (if configured).

## 3. Architecture Options & Tradeoffs

### Option A: Centralized Cloud Processing (Rejected)
* **Description**: Stream raw video to a central cloud server for processing.
* **Failure Modes**: High bandwidth costs; latency violations (>2s alerts) due to network jitter; severe privacy risk as raw video leaves the premises.

### Option B: Edge-First Decoupled Pipeline (Recommended)
* **Description**: Process all video locally on the NVIDIA L4. Only derived events are stored long-term.
* **Advantages**:
    *   **Privacy**: Raw video never leaves the store; no biometric data is generated.
    *   **Latency**: Local processing ensures <2s alerting.
    *   **Availability**: 99.9% SLA is achievable with local redundancy (RAID) and failover logic.
* **Disadvantages**:
    *   **Throughput Risk**: The L4 GPU must handle 12 cameras at 15 FPS simultaneously. This requires careful model selection and benchmarking.
    *   **Operational Cost**: Requires on-prem hardware maintenance and local storage management.

### Option C: Hybrid Edge-Cloud (Rejected for Pilot)
* **Description**: Edge processes video; cloud aggregates events for cross-store analytics.
* **Failure Modes**: Adds complexity for the 8-week pilot; potential privacy leaks if cross-store correlation is attempted.
* **Rejection Reason**: Unnecessary complexity for the pilot scope; violates the "no re-identification" constraint if not strictly controlled.

## 4. Failure Modes & Mitigations

| Failure Mode | Impact | Mitigation |
|:--- |:--- |:--- |

| **Storage Failure** | Loss of raw video or events. | Implement RAID 1/5 on local storage. Monitor disk health. |
| **Privacy Leak** | Re-identification via track correlation. | Reset track IDs periodically. Do not store bounding box metadata long-term. Exclude facial features from detection. |
| **GPU Failure** | Complete loss of tracking capability. | Implement graceful degradation: switch to CPU-based fallback (lower FPS) or alert for hardware replacement. |
| **Network Partition** | Loss of alert delivery. | Buffer alerts locally; retry when connection is restored. |

## 5. Open Decisions & Assumptions

### 5.1 Critical Benchmarks Required
* **Model Throughput**: **Must benchmark** the chosen detection model (e.g., YOLOv8-nano) on the NVIDIA L4 with 12 concurrent streams at 15 FPS.
    *   *Assumption*: The L4 can handle 12 streams at 15 FPS with a lightweight model. If not, we must reduce FPS, resolution, or camera count.
* **Latency Profile**: Measure end-to-end latency from frame capture to alert generation.
    *   *Assumption*: Local processing will meet the <2s requirement.

### 5.2 Unresolved Requirements
* **Zone Definition**: How are zones defined? (Manual polygon drawing? AI-generated?) This impacts the Event Processor complexity.
* **Alert Thresholds**: What constitutes a "dwell time" alert? (e.g., >5 minutes?) This needs business input.
* **Camera Calibration**: Are cameras calibrated for perspective correction? This affects tracking accuracy.

### 5.3 Assumptions
* **Hardware Availability**: NVIDIA L4 GPUs are available and compatible with the chosen software stack.
* **Network Stability**: Local network between cameras and edge box is stable and low-latency.
* **Privacy Compliance**: The defined architecture meets local regulatory requirements for anonymous tracking.

## 6. Implementation Plan (8-Week Pilot)

### Week 1-2: Foundation & Benchmarking
* Set up local development environment.
* **Benchmark**: Test detection models on L4 with 12 streams. Select optimal model.
* Implement Ingestion Service and basic Detection/Tracking Engine.

### Week 3-4: Event Processing & Storage
* Implement Event Processor (zone logic, dwell time).
* Set up local storage (RAID, circular buffer for video, time-series DB for events).
* Implement anonymous ID rotation logic.

### Week 5-6: Integration & Testing
* Integrate all components.
* Test end-to-end latency and throughput.
* Validate privacy controls (no biometric data, ID rotation).
* Deploy to one store for pilot testing.

### Week 7-8: Rollout & Refinement
* Deploy to remaining two stores.
* Monitor system health, latency, and alert accuracy.
* Gather feedback and refine zone definitions/alert thresholds.
* Document lessons learned and final architecture.

## 7. Conclusion
The **Edge-First Decoupled Pipeline** is the only viable architecture that meets the strict privacy, latency, and availability constraints. Success depends on **early benchmarking** of the detection model on the NVIDIA L4 to ensure throughput requirements are met. The team must explicitly define zone logic and alert thresholds during the pilot.

### Implementation Plan

# Implementation Plan: Privacy-Preserving Retail Person Tracking

This plan translates the selected **Edge-First Decoupled Pipeline** architecture into an executable eight-week pilot sequence. It details provisioning, configuration, deployment, migration, verification, ownership, and rollback actions for three retail locations, each equipped with 12 RTSP cameras and one NVIDIA L4 edge box.

## 1. Execution Strategy & Phasing

The pilot is divided into four two-week increments. Each increment delivers a verifiable slice of functionality, ensuring that privacy constraints and latency targets are validated early.

* **Weeks 1–2: Foundation & Inference Benchmarking**
    *   Goal: Establish hardware readiness, deploy the ingestion layer, and validate model throughput.

* **Weeks 3–4: Event Processing & Local Storage**
    *   Goal: Implement the event processor, local storage policies, and anonymous track ID generation.
    *   Critical Path: Verifying that raw video is retained for only 24 hours and events for 30 days [User brief].
* **Weeks 5–6: Alerting & Integration**
    *   Goal: Connect the event processor to the alerting engine and validate end-to-end latency.
    *   Critical Path: Ensuring alerts arrive in under 2 seconds [User brief].
* **Weeks 7–8: Hardening, Rollout & Pilot Validation**
    *   Goal: Deploy to all three stores, conduct load testing, and finalize privacy compliance documentation.
    *   Critical Path: Achieving 99.9% availability and resolving any privacy leak risks [Requirements & Constraints Analyst].

## 2. Detailed Incremental Actions

### Increment 1: Foundation & Inference Benchmarking (Weeks 1–2)

**Provisioning & Configuration:**
1. **Edge Box Setup**: Provision three NVIDIA L4 edge boxes with Ubuntu 22.04 LTS, NVIDIA Container Toolkit, and Docker Compose.
2. **Network Configuration**: Configure static IPs for edge boxes and ensure low-latency connectivity to the 12 RTSP cameras per store.
3. **Ingestion Service Deployment**: Deploy the RTSP ingestion service (e.g., GStreamer or FFmpeg-based) to pull streams from all 12 cameras.

**Verification & Benchmarking:**
1. **Model Benchmarking**: Run the selected detection/tracking model (e.g., YOLOv8 + ByteTrack) on the L4 GPU. Measure FPS per camera at 15 FPS input.
    *   *Assumption*: The model runs at ≥15 FPS per camera.
2. **Throughput Validation**: Verify that the ingestion service can handle 12 streams simultaneously without dropping frames.

**Ownership & Rollback:**
* **Owner**: Infrastructure Engineer.
* **Rollback**: Revert to previous Docker image if ingestion fails.

### Increment 2: Event Processing & Local Storage (Weeks 3–4)

**Provisioning & Configuration:**
1. **Event Processor Deployment**: Deploy the event processor service to generate derived events (dwell time, zone entry) from tracking data.
2. **Storage Configuration**: Configure local storage on the edge box with RAID for redundancy.
3. **Retention Policy Implementation**: Implement cron jobs or a storage manager to delete raw video after 24 hours and events after 30 days.

**Verification & Benchmarking:**

2. **Storage Failure Simulation**: Simulate a disk failure to verify RAID redundancy and data integrity.

**Ownership & Rollback:**
* **Owner**: Backend Engineer.
* **Rollback**: Restore storage from backup if data corruption occurs.

### Increment 3: Alerting & Integration (Weeks 5–6)

**Provisioning & Configuration:**
1. **Alerting Engine Deployment**: Deploy the alerting engine to consume events from the event processor.
2. **Threshold Configuration**: Define alert thresholds (e.g., dwell time >5 minutes). *Open Decision*: Business input required for specific thresholds.
3. **Integration Testing**: Connect the alerting engine to the notification system (e.g., email, SMS, or dashboard).

**Verification & Benchmarking:**

2. **Load Testing**: Simulate high traffic (e.g., 12 cameras at 15 FPS) to verify alerting performance under load.

**Ownership & Rollback:**
* **Owner**: Full-Stack Engineer.
* **Rollback**: Disable alerting if false positives exceed acceptable levels.

### Increment 4: Hardening, Rollout & Pilot Validation (Weeks 7–8)

**Provisioning & Configuration:**
1. **Full Deployment**: Deploy the complete stack to all three retail stores.
2. **Monitoring Setup**: Implement monitoring (e.g., Prometheus/Grafana) to track system health, latency, and storage usage.

**Verification & Benchmarking:**

**Ownership & Rollback:**
* **Owner**: Engineering Lead.
* **Rollback**: Revert to previous stable version if critical issues arise.

## 3. Open Decisions & Assumptions

**Open Decisions:**
1. **Alert Thresholds**: What constitutes a "dwell time" alert? (e.g., >5 minutes?) This needs business input.
2. **Camera Calibration**: Are cameras calibrated for perspective correction? This affects tracking accuracy.

**Assumptions:**
1. **Hardware Availability**: NVIDIA L4 GPUs are available and compatible with the chosen software stack.
2. **Network Stability**: Local network between cameras and edge box is stable and low-latency.
3. **Privacy Compliance**: The defined architecture meets local regulatory requirements for anonymous tracking.

## 4. Risks & Mitigations

* **R1: Throughput Bottleneck**: If the chosen model runs at <15 FPS per camera on the L4, the system will drop frames. *Mitigation*: Benchmark early; consider model quantization (TensorRT) or reducing input resolution.
* **R2: Storage Failure**: If local storage fails, raw video is lost. *Mitigation*: Implement RAID or redundant storage on the edge box.

## 5. Resource Allocation

* **Engineers**: Four engineers are allocated across the increments.
    *   **Infrastructure Engineer**: Focuses on edge box setup, network configuration, and storage.
    *   **Backend Engineer**: Focuses on event processing, storage policies, and privacy compliance.
    *   **Full-Stack Engineer**: Focuses on alerting, integration, and monitoring.
    *   **Engineering Lead**: Oversees the pilot, conducts privacy audits, and manages open decisions.

This plan provides a clear, executable path to delivering the privacy-preserving person-tracking system within the eight-week pilot timeline, while respecting all hard constraints and surface assumptions for owner resolution.

### Risk Register

# Risk Register: Privacy-Preserving Retail Person Tracking

This register identifies concrete, testable risks derived from the engineering brief and architecture decision record. Risks are categorized by domain and prioritized by severity (Blocker, High, Medium). Each entry includes the risk description, potential impact, proposed mitigation, residual risk, and unknowns.

## 1. Privacy & Compliance Risks

### P1: Re-identification via Trajectory Correlation
* **Risk**: Although facial recognition and biometrics are excluded, correlating anonymous track IDs across multiple cameras or over extended time windows may allow re-identification of individuals through unique movement patterns, gait, or clothing.
* **Impact**: Violation of privacy constraints; potential regulatory non-compliance (e.g., GDPR, CCPA).
* **Mitigation**:
    *   Implement strict track ID expiration (e.g., reset ID upon leaving a camera’s field of view or after a short timeout).
    *   Avoid cross-camera track ID persistence unless explicitly required for dwell time calculation, and if used, ensure data is anonymized and aggregated before storage.
    *   Conduct a privacy impact assessment (PIA) to evaluate re-identification likelihood.
* **Residual Risk**: Medium. Re-identification risk persists if high-resolution video is retained for 24 hours and correlated with external data sources.
* **Unknowns**: Legal interpretation of "anonymous" tracking in target jurisdictions; effectiveness of proposed anonymization techniques against advanced re-identification algorithms.

### P2: Data Retention Policy Enforcement Failure
* **Risk**: Failure to automatically delete raw video after 24 hours or derived events after 30 days due to software bugs, storage errors, or manual override.
* **Impact**: Privacy violation; increased liability; potential regulatory fines.
* **Mitigation**:
    *   Implement automated, immutable deletion policies using cron jobs or event-driven triggers.
    *   Add monitoring alerts for retention policy violations (e.g., if files older than 24 hours exist).
    *   Regularly audit storage systems to verify compliance.
* **Residual Risk**: Low. Automated systems reduce human error, but bugs or misconfigurations remain possible.
* **Unknowns**: Robustness of deletion mechanisms under high load or storage failure scenarios.

## 2. Availability & Reliability Risks

### A1: Edge Box Hardware Failure
* **Risk**: Failure of the NVIDIA L4 GPU, CPU, or storage in an edge box leads to complete loss of tracking capability for that store.
* **Impact**: Violation of 99.9% availability target; loss of real-time alerts and data.
* **Mitigation**:
    *   Implement RAID for local storage to protect against disk failure.
    *   Design for graceful degradation: if GPU fails, switch to CPU-based inference (if feasible) or alert operators immediately.
    *   Consider redundant edge boxes per store (if budget allows) or rapid replacement procedures.
* **Residual Risk**: High. Single point of failure per store; 99.9% availability requires mean time to repair (MTTR) < 8.76 hours/year per store, which is challenging with on-prem hardware.
* **Unknowns**: Actual MTTR for hardware replacement; feasibility of CPU-based fallback inference.

### A2: Network Instability Between Cameras and Edge Box
* **Risk**: Packet loss or latency spikes in the local network disrupt video streams, causing frame drops or tracking errors.
* **Impact**: Missed alerts; inaccurate dwell time calculations; reduced system reliability.
* **Mitigation**:
    *   Use wired Ethernet connections for all cameras.
    *   Implement stream buffering and error recovery mechanisms in the ingestion pipeline.
    *   Monitor network health and alert on anomalies.
* **Residual Risk**: Medium. Wired networks are stable, but physical damage or configuration errors can still cause issues.
* **Unknowns**: Quality of existing network infrastructure in retail stores; susceptibility to electromagnetic interference.

## 3. Performance & Capacity Risks

### C1: Inference Throughput Bottleneck
* **Risk**: The chosen model runs at <15 FPS per camera on the L4 GPU, causing frame drops and violating the 15 FPS input constraint.
* **Impact**: Missed detections; inaccurate tracking; potential alert delays.
* **Mitigation**:
    *   **Benchmark early**: Measure actual FPS per camera with the selected model and input resolution.
    *   Optimize model using TensorRT quantization or pruning.
    *   Reduce input resolution if accuracy permits.
    *   Consider multi-camera batching or asynchronous processing.
* **Residual Risk**: High. If benchmarks show insufficient throughput, the architecture may need significant redesign (e.g., fewer cameras per box, different hardware).
* **Unknowns**: Actual model performance on L4 GPU; trade-off between resolution, accuracy, and speed.

### C2: Storage Capacity Exhaustion
* **Risk**: Raw video retention (24 hours) and event storage (30 days) exceed available disk space on the edge box.
* **Impact**: System crash; data loss; inability to process new video.
* **Mitigation**:
    *   Calculate exact storage requirements based on camera resolution, frame rate, and compression.
    *   Implement aggressive video compression (e.g., H.265).
    *   Use tiered storage: keep recent video on fast SSD, archive older data to slower HDD or cloud (if allowed).
* **Residual Risk**: Medium. Miscalculation of storage needs or unexpected growth in event data could lead to issues.
* **Unknowns**: Actual compression ratios; growth rate of derived events.

## 4. Operability & Observability Risks

### O1: Lack of Monitoring and Alerting
* **Risk**: Inability to detect system failures, performance degradation, or privacy violations in real-time.
* **Impact**: Extended downtime; undetected privacy breaches; delayed incident response.
* **Mitigation**:
    *   Implement comprehensive monitoring for GPU utilization, CPU load, memory, disk space, and network health.
    *   Add application-level metrics: FPS, track count, alert latency, error rates.
    *   Set up alerts for critical thresholds (e.g., FPS < 10, disk > 90% full).
* **Residual Risk**: Low. Monitoring is essential for operability; implementation is straightforward but requires effort.
* **Unknowns**: Complexity of integrating monitoring tools with the existing stack; alert fatigue management.

### O2: Difficulty in Debugging Tracking Errors
* **Risk**: Inability to diagnose why tracking fails (e.g., missed detections, ID switches) due to lack of observability into the model’s decisions.
* **Impact**: Prolonged debugging; reduced system accuracy; loss of trust in the system.
* **Mitigation**:
    *   Log bounding boxes, track IDs, and confidence scores for a subset of frames.
    *   Implement a debugging interface to visualize tracking results.
    *   Store sample video clips for failed tracks for offline analysis.
* **Residual Risk**: Medium. Logging and visualization add overhead; balancing observability with privacy and performance is challenging.
* **Unknowns**: Storage and compute cost of detailed logging; privacy implications of storing debug data.

## 5. Implementation & Timeline Risks

### T1: Insufficient Time for Benchmarking and Optimization
* **Risk**: The eight-week pilot timeline does not allow adequate time for model benchmarking, optimization, and testing.
* **Impact**: Delivery of a suboptimal system; missed performance targets; privacy or reliability issues.
* **Mitigation**:
    *   Prioritize benchmarking in the first two weeks.
    *   Use pre-optimized models or frameworks (e.g., TensorRT) to reduce optimization effort.
    *   Define clear go/no-go criteria based on benchmark results.
* **Residual Risk**: High. If benchmarks reveal significant issues, the timeline may be insufficient for resolution.
* **Unknowns**: Actual time required for benchmarking and optimization; availability of pre-optimized models.

### T2: Team Capacity Constraints
* **Risk**: Four engineers are insufficient to handle development, testing, deployment, and operations for three stores.
* **Impact**: Burnout; delayed delivery; poor quality.
* **Mitigation**:
    *   Automate deployment and testing pipelines.
    *   Focus on a single store for the initial pilot, then replicate.
    *   Clearly define roles and responsibilities.
* **Residual Risk**: Medium. Automation reduces effort, but unexpected issues can still strain the team.
* **Unknowns**: Actual complexity of deployment and operations; availability of additional resources if needed.

## Summary of Critical Actions

1. **Benchmark Model Throughput**: Immediately measure FPS per camera on the L4 GPU with the selected model. This is a blocker for the architecture.
2. **Define Privacy Boundaries**: Clarify legal requirements for anonymous tracking and implement strict track ID expiration and data retention policies.
3. **Implement Monitoring**: Set up comprehensive monitoring and alerting from day one to ensure operability and early detection of issues.
4. **Plan for Hardware Failure**: Develop procedures for rapid hardware replacement and consider graceful degradation strategies.
5. **Validate Storage Requirements**: Calculate exact storage needs and implement automated deletion policies to prevent capacity exhaustion.

This register should be reviewed and updated regularly as the project progresses and new information becomes available.

### Verification Strategy

# Verification Strategy & Progressive Rollout Plan

This strategy traces every verification check to the supplied requirements, the Edge-First Decoupled Pipeline architecture, the eight-week implementation plan, and the identified material risks.

## 1. Verification Strategy

### 1.1 Unit & Component Verification
* **Privacy Compliance (Unit)**: Verify that the detection model output excludes facial features or biometric descriptors.

    *   *Check*: Code review of model output schema; unit tests asserting absence of face/biometric keys in event payloads.
* **Track ID Lifecycle (Unit)**: Verify that track IDs are scoped to camera/session and expire as defined.
    *   *Trace*: Derived Constraint: Short-lived track IDs [Requirements & Constraints Analyst]; Risk P1 [Security & Reliability Reviewer].
    *   *Check*: Unit tests simulating track expiration upon camera exit or timeout. **Owner Decision Needed**: Define exact timeout duration (e.g., 1 hour) and expiration trigger logic.
* **Event Generation Logic (Unit)**: Verify correct calculation of dwell time and zone entry/exit.
    *   *Trace*: Functional Criterion: Event Generation [Requirements & Constraints Analyst].
    *   *Check*: Unit tests with synthetic centroid data validating event thresholds. **Owner Decision Needed**: Define specific alert thresholds (e.g., dwell time > X seconds) [Delivery Planning Agent].

### 1.2 Integration & System Verification
* **End-to-End Latency (Integration)**: Verify alerts arrive in <2 seconds from visual occurrence.

    *   *Check*: Instrumented end-to-end test using timestamped video injection and alert receipt logging.
* **Data Retention Enforcement (Integration)**: Verify raw video is deleted after 24 hours and events after 30 days.

    *   *Check*: Automated audit script checking file ages in storage; integration test simulating time passage to verify deletion triggers.
* **Throughput & Resource Utilization (Integration)**: Verify system handles 12 cameras at 15 FPS without dropping frames or exceeding GPU limits.
    *   *Trace*: Hard Constraint: 15 FPS input [User brief]; Non-Functional Criterion: GPU <90% [Requirements & Constraints Analyst]; Risk C1 [Security & Reliability Reviewer].
    *   *Check*: Load test with 12 concurrent RTSP streams.

### 1.3 Security & Privacy Verification
* **Re-identification Resistance (Security)**: Verify that track IDs cannot be correlated across cameras or time to re-identify individuals.
    *   *Trace*: Risk P1 [Security & Reliability Reviewer].
    *   *Check*: Privacy Impact Assessment (PIA) review; static analysis of data flow ensuring no cross-camera ID persistence unless explicitly anonymized.
* **Storage Security (Security)**: Verify local storage is encrypted and access-controlled.
    *   *Trace*: Architecture: Local Storage [Systems Architecture Agent].
    *   *Check*: Configuration audit for disk encryption and API gateway access controls.

### 1.4 Observability & Failure Injection
* **Observability (Observability)**: Verify monitoring captures latency, GPU utilization, storage usage, and alert rates.
    *   *Trace*: Increment 4 [Delivery Planning Agent].
    *   *Check*: Validate Prometheus/Grafana dashboards and alert rules.
* **Failure Injection (Chaos)**: Verify system behavior under failure conditions.
    *   *Trace*: Risk A1 (GPU Failure) [Security & Reliability Reviewer]; Risk A2 (Network Instability) [Security & Reliability Reviewer].
    *   *Check*: Inject GPU failure (simulate crash) to verify graceful degradation or alerting; inject network packet loss to verify stream recovery.

## 2. Progressive Rollout Plan

### Phase 1: Single-Store Pilot (Weeks 7-8, Store 1)
* **Scope**: Deploy full stack to one retail store.
* **Entry Criteria**: All unit and integration tests pass in lab environment; benchmarks confirm throughput.
* **Actions**:
    1.  Deploy edge box and services to Store 1.
    2.  Enable monitoring and observability.
    3.  Run in "shadow mode" (processing but not alerting) for 48 hours to validate stability.
* **Pass Condition**: System runs for 48 hours with >99.9% availability, no privacy leaks, and latency <2s.
* **Rollback Condition**: Critical bug, privacy violation, or sustained latency >2s. Revert to previous stable version or disable services.

### Phase 2: Multi-Store Expansion (Weeks 8+, Stores 2 & 3)
* **Scope**: Deploy to remaining two stores.
* **Entry Criteria**: Store 1 pilot passes all criteria.
* **Actions**:
    1.  Deploy edge boxes and services to Stores 2 and 3.
    2.  Enable monitoring and observability.
    3.  Run in "shadow mode" for 48 hours per store.
* **Pass Condition**: Both stores run for 48 hours with >99.9% availability, no privacy leaks, and latency <2s.
* **Rollback Condition**: Critical bug, privacy violation, or sustained latency >2s in either store. Revert to previous stable version or disable services.

### Phase 3: Full Production & Alerting (Post-Pilot)
* **Scope**: Enable alerting for all stores.
* **Entry Criteria**: Multi-store expansion passes all criteria; business approves alert thresholds.
* **Actions**:
    1.  Enable alerting for all stores.
    2.  Monitor alert volume and false positive rate.
* **Pass Condition**: Alert volume is within acceptable limits; false positive rate is low.
* **Rollback Condition**: Excessive false positives or alert fatigue. Disable alerting and tune thresholds.

## 3. Open Decisions & Required Benchmarks

### Critical Benchmarks (Must Be Completed Before Phase 1)

3. **End-to-End Latency**: Measure latency from frame capture to alert generation under load.

### Owner Decisions Needed
1. **Track ID Timeout**: Define exact duration for track ID expiration (e.g., 1 hour).
2. **Alert Thresholds**: Define specific thresholds for alerts (e.g., dwell time > X seconds).
3. **Camera Resolution & Codec**: Confirm resolution and codec for RTSP streams to finalize storage and bandwidth calculations.

### Engineering Recommendation

# Engineering Recommendation: Privacy-Preserving Retail Person Tracking

## Executive Summary
This recommendation synthesizes requirements, architecture, delivery planning, risk assessment, and verification strategies into a single decision-ready plan for an eight-week pilot. The proposed **Edge-First Decoupled Pipeline** architecture satisfies all hard constraints, including strict privacy compliance (no biometrics), <2s alert latency, and 99.9% availability, while explicitly surfacing critical open decisions and benchmarking requirements.

## 1. Recommended Architecture: Edge-First Decoupled Pipeline
The system is designed as three autonomous islands, one per store, to minimize network dependency and ensure privacy by design.

### Component Topology (Per Store)
1. **Ingestion Service**: Pulls 12 RTSP streams at 15 FPS. Converts frames to a standardized internal format (e.g., NV12).
2. **Detection & Tracking Engine**: Runs on the NVIDIA L4 GPU. Uses a lightweight model (e.g., YOLOv8-nano) for person detection and a multi-object tracker (e.g., ByteTrack) for anonymous, short-lived track IDs.
3. **Event Processor**: Consumes track centroids to generate derived events (Zone Entry, Dwell Time) and alerts.
4. **Storage Layer**:
    *   **Raw Video**: Circular buffer on local NVMe/SSD. Retention: 24 hours.
    *   **Events**: Local time-series database (e.g., TimescaleDB). Retention: 30 days.
5. **API Gateway**: Exposes event queries and alert subscriptions. Does not expose raw video or tracking metadata externally.

### Tradeoff Analysis
* **Rejected Option: Centralized Cloud Processing**. Rejected due to high bandwidth costs, latency violations (>2s alerts) from network jitter, and severe privacy risks as raw video leaves the premises.
* **Selected Option: Edge-First Decoupled Pipeline**.
    *   *Advantages*: Ensures privacy (raw video stays local), meets latency targets (<2s), and achieves 99.9% availability via local redundancy.
    *   *Disadvantages*: Throughput risk. The L4 GPU must handle 12 cameras at 15 FPS simultaneously. This requires rigorous benchmarking to confirm feasibility.

## 2. Implementation Plan: Eight-Week Pilot
The pilot is divided into four two-week increments, delivering verifiable slices of functionality.

### Increment 1: Foundation & Inference Benchmarking (Weeks 1–2)
* **Goal**: Establish hardware readiness and validate model throughput.
* **Actions**:
    *   Provision three NVIDIA L4 edge boxes with Ubuntu 22.04 LTS, NVIDIA Container Toolkit, and Docker Compose.
    *   Deploy RTSP ingestion service for 12 cameras per store.
    *   **Critical Benchmark**: Run detection/tracking model (e.g., YOLOv8 + ByteTrack) on L4 GPU. Measure FPS per camera at 15 FPS input. *Assumption*: Model runs at ≥15 FPS per camera. Verify ingestion service handles 12 streams without frame drops.

### Increment 2: Event Processing & Local Storage (Weeks 3–4)
* **Goal**: Implement event processing and storage policies.
* **Actions**:
    *   Deploy event processor for derived events (dwell time, zone entry).
    *   Configure local storage with RAID for redundancy.
    *   Implement retention policies: Delete raw video after 24 hours and events after 30 days.
    *   **Verification**: Simulate disk failure to verify RAID redundancy.

### Increment 3: Alerting & Integration (Weeks 5–6)
* **Goal**: Validate end-to-end latency and alerting.
* **Actions**:
    *   Connect event processor to alerting engine.
    *   **Critical Path**: Ensure alerts arrive in under 2 seconds.

### Increment 4: Hardening, Rollout & Pilot Validation (Weeks 7–8)
* **Goal**: Deploy to all three stores and finalize compliance.
* **Actions**:
    *   Conduct load testing and privacy compliance documentation.
    *   **Critical Path**: Achieve 99.9% availability and resolve privacy leak risks.

## 3. Risk Register & Mitigations
### Privacy & Compliance Risks
* **P1: Re-identification via Trajectory Correlation**.
    *   *Risk*: Correlating anonymous track IDs across cameras/time may allow re-identification.
    *   *Mitigation*: Strict track ID expiration (reset on camera exit/timeout). Avoid cross-camera persistence unless anonymized. Conduct Privacy Impact Assessment (PIA).
* **P2: Data Retention Policy Enforcement Failure**.
    *   *Risk*: Failure to delete raw video after 24h or events after 30d.
    *   *Mitigation*: Automated, immutable deletion policies. Monitoring alerts for violations. Regular audits.

### Availability & Reliability Risks
* **A1: Edge Box Hardware Failure**.
    *   *Risk*: GPU/CPU/storage failure causes complete loss of tracking for a store.
    *   *Mitigation*: RAID for storage. Graceful degradation (CPU fallback if feasible). Rapid replacement procedures. *Residual Risk*: High. Single point of failure per store; 99.9% availability requires MTTR < 8.76 hours/year.

## 4. Verification Strategy
### Quality Gates
* **Privacy Compliance**: Code review ensuring no facial/biometric data in event payloads. Unit tests for track ID expiration.
* **End-to-End Latency**: Instrumented test verifying alerts arrive in <2 seconds from visual occurrence.
* **Data Retention**: Automated audit script verifying file ages and deletion triggers.
* **Throughput**: Load test with 12 concurrent RTSP streams to verify no frame drops and GPU utilization <90%.

## 5. Open Decisions & Required Benchmarks
### Critical Unknowns (Must Be Resolved Before Implementation)
1. **Camera Resolution & Codec**: The query specifies 15 FPS but not resolution (e.g., 1080p, 4K) or codec (H.264, H.265). This drastically impacts bandwidth, storage, and decoding overhead.
2. **Track ID Timeout Duration**: Define exact timeout duration (e.g., 1 hour) and expiration trigger logic for short-lived track IDs.
3. **Alert Thresholds**: Define specific alert thresholds (e.g., dwell time > X seconds).

### Required Benchmarks
* **Model Throughput**: Benchmark selected detection/tracking model (e.g., YOLOv8 + ByteTrack) on NVIDIA L4 GPU. Measure FPS per camera at 15 FPS input. *Do not assume throughput; measure it*.
* **Ingestion Throughput**: Verify ingestion service handles 12 streams simultaneously without dropping frames.

## 6. Next Actions
1. **Resolve Open Decisions**: Team lead to define camera resolution/codec, track ID timeout, and alert thresholds.
2. **Benchmarking**: Infrastructure Engineer to perform model and ingestion throughput benchmarks in Week 1.
3. **Privacy Impact Assessment**: Conduct PIA to evaluate re-identification risks and legal compliance.
4. **Procurement**: Ensure NVIDIA L4 edge boxes and storage hardware are procured and ready for Week 1 provisioning.

## Decision-ready Match-3 launch plan

### Standard Base Qwen

This is a lean, high-risk scenario. With $25,000 across three major English-speaking markets and no IP, you cannot afford to "brand" your way to success. You must validate **product-market fit** and **user acquisition efficiency** before the soft launch.

Here is the execution plan, strictly separated into facts and hypotheses, followed by the testing protocol.

### Part 1: Facts vs. Hypotheses

**Supplied Facts (Constraints & Assets)**
1.  **Budget:** $25,000 total.
2.  **Markets:** US, UK, Canada (Tier 1 markets; high CPI, high LTV potential).
3.  **Platforms:** iOS and Android.
4.  **Timeline:** 6 weeks until soft launch.
5.  **Assets:** Gameplay video exists. No existing audience. No licensed IP.
6.  **Monetization Model:** Hybrid (Ads + IAP).
7.  **Current State:** No validated personas, no performance claims.

**Hypotheses (Assumptions to be Tested)**
1.  **Creative Hypothesis:** The current gameplay video will generate a Click-Through Rate (CTR) > 1.5% and a Cost Per Install (CPI) < $1.50 in Tier 1 markets.
2.  **Audience Hypothesis:** The game appeals to a specific demographic (e.g., women 35-54, casual puzzle fans) rather than a broad "everyone" audience.
3.  **Retention Hypothesis:** Users who install will retain at Day 1 (D1) > 35% and Day 7 (D7) > 15%.
4.  **Monetization Hypothesis:** The hybrid model will generate enough early revenue (ARPU) to offset the high CPI of Tier 1 markets within the first 7 days.
5.  **Platform Hypothesis:** iOS and Android will have similar CPI and retention profiles (this is often false; iOS users often spend more but cost more to acquire).

---

### Part 2: The 6-Week Execution Plan

**Goal:** Determine if the game is viable to scale. If key metrics fail, you pivot or cancel before the soft launch.

#### Week 1: Infrastructure & Creative Prep (Zero Spend)
*   **Analytics Setup:** Implement deep-linking and event tracking. You must track: Install, First Level Complete, First Ad Watch, First IAP, D1/D7/D14 Retention.
*   **Creative Variants:** Do not rely on one video. Create 3 distinct creative angles from your gameplay footage:
    1.  **Pure Gameplay:** Fast-paced, satisfying matches, no text.
    2.  **Problem/Solution:** "Stuck on level 50? Use this hint!" (Implies depth).
    3.  **Social/Competitive:** "Beat your friends' scores!" (Implies community).
*   **Store Listing:** Prepare a basic App Store/Play Store listing. You need a live link to test installs.

#### Week 2-3: The "Smoke Test" (Spend: $5,000)
*   **Objective:** Validate Creative CTR and Initial CPI.
*   **Platform:** Meta (Facebook/Instagram) Ads Manager. *Why? It’s the fastest way to get data on creative performance and audience targeting.*
*   **Strategy:**
    *   Split budget: $1,666 per market (US, UK, CA).
    *   Split budget: 50% iOS, 50% Android.
    *   Run 3 ad sets (one per creative variant) per market/platform.
    *   **Targeting:** Broad interest targeting (e.g., "Puzzle games," "Candy Crush," "Match-3"). Do not over-segment yet.
*   **Success Metric:**
    *   **CTR:** > 1.5%. If lower, your creative is weak. Kill underperforming variants.
    *   **CPI:** < $2.00. If higher, your creative isn't resonating, or the market is too expensive for your current hook.

#### Week 4-5: The "Retention & Monetization" Test (Spend: $15,000)
*   **Objective:** Validate D1/D7 Retention and Early ARPU (Average Revenue Per User).
*   **Platform:** Meta + TikTok (if feasible) or Google UAC. *Stick to Meta for consistency if team is small.*
*   **Strategy:**
    *   Focus budget on the **top 2 performing creatives** from Weeks 2-3.
    *   Increase daily spend to get statistically significant data (aim for 500-1,000 installs per variant).
    *   **Critical:** Ensure your analytics are tracking *revenue* from ads and IAPs.
*   **Success Metrics (The "Go/No-Go" Gates):**
    *   **D1 Retention:** > 35%. (If < 30%, the core loop is broken. Do not scale.)
    *   **D7 Retention:** > 15%. (If < 10%, long-term viability is low.)
    *   **CPI:** < $1.50. (Tier 1 markets are expensive; you need efficiency.)
    *   **Day 7 ARPU:** > $0.10. (This is a conservative baseline for hybrid models. If lower, your monetization is too weak.)

#### Week 6: Analysis & Soft Launch Prep (Spend: $5,000)
*   **Objective:** Final validation and audience segmentation.
*   **Strategy:**
    *   Run a small test to see if **gender** or **age** segments perform differently.
    *   Test a new creative angle based on insights from Weeks 2-5 (e.g., if "Problem/Solution" worked, try a "Tutorial" angle).
    *   **Final Decision:** Based on aggregated data, decide:
        1.  **Scale:** Metrics meet thresholds. Proceed to soft launch with optimized creatives and targeting.
        2.  **Pivot:** Retention is good, but CPI is high. Need better creatives or cheaper markets (e.g., Brazil, India) for scale.
        3.  **Kill:** Retention is poor. Core gameplay needs redesign.

---

### Part 3: What to Test Before Scaling

Do not scale until you have validated these three pillars:

1.  **Creative Efficiency:**
    *   *Test:* Which creative angle (Gameplay, Problem/Solution, Social) drives the lowest CPI?
    *   *Why:* In Match-3, creative is 80% of your success. You need 5-10 winning creatives before scaling.

2.  **Core Loop Retention:**
    *   *Test:* D1 and D7 retention rates.
    *   *Why:* If users don’t come back, no amount of marketing will save you. This is a product issue, not a marketing issue.

3.  **Monetization Balance:**
    *   *Test:* Ratio of Ad Revenue vs. IAP Revenue.
    *   *Why:* If 90% of revenue is from IAP, you’re missing out on the "free" audience. If 90% is from ads, you’re annoying users and hurting retention. Aim for a balanced hybrid (e.g., 60% Ads / 40% IAP or vice versa, depending on your design).

---

### Part 4: Critical Warnings & Next Steps

*   **No Benchmarks:** I have not provided industry benchmarks because they vary wildly by sub-genre, art style, and time. Use the **thresholds** above as *minimums* for viability. If you exceed them, you’re in good shape. If you fall short, you have a problem.
*   **Tier 1 Markets are Expensive:** US/UK/CA have high CPIs. If your CPI is $2.00, you need a Day 7 ARPU of at least $0.20-$0.30 to break even. Be realistic.
*   **Soft Launch is Not a Launch:** The soft launch is for **tuning**, not scaling. Do not spend your entire $25k on the soft launch. Use this test to prove the model, then raise more capital or use organic growth for the actual launch.
*   **Team Execution:**
    *   **Day 1:** Set up analytics and ad accounts.
    *   **Day 3:** Finalize 3 creative variants.
    *   **Day 7:** Launch Week 2 test.
    *   **Day 14:** Review Week 2 data, kill losers, scale winners.
    *   **Day 21:** Launch Week 4 test.
    *   **Day 35:** Final analysis.

**Immediate Action:** Start building the 3 creative variants and setting up analytics today. Time is your scarcest resource.

### Agent-Team Qwen

# Execution-Ready Soft Launch Plan: Free-to-Play Match-3 Game

This plan provides a concrete, six-week strategy for your soft launch. It strictly separates **Verified Constraints** (facts you provided) from **Testable Hypotheses** (assumptions you must validate). No industry benchmarks are invented; all decisions rely on internal data generated during the test.

## 1. Verified Constraints (Supplied Facts)
*These are the non-negotiable inputs for this plan.*

* **Product:** Free-to-play (F2P) Match-3 mobile game.
* **Monetization:** Hybrid model (Ads + In-App Purchases/IAP).
* **Budget:** $25,000 total test budget.
* **Timeline:** Soft launch in six weeks.
* **Platforms:** iOS and Android.

* **Assets:** Gameplay video available; no existing audience; no licensed IP.

## 2. Strategic Positioning & Audience Hypotheses
*Since there is no existing audience or IP, we must test assumptions about who plays and why. These are hypotheses, not facts.*

### Core Positioning
* **Value Proposition:** "Free, fair, and fun."
* **Differentiation:** Emphasize player choice. The hybrid model allows users to watch ads for rewards *or* buy them, addressing the common "pay-to-win" objection in the genre.
* **Voice:** Simple, encouraging, and non-competitive. Avoid "hardcore" gaming jargon to appeal to casual players.

### Audience Hypotheses to Test
1. **The "Casual Time-Filler":** Broad demographic (25–55+), skewing female. Motivated by relaxation and low-stakes wins. *Test:* Monitor session length and Day 1 retention.
2. **The "Ad-Tolerant Free Player":** Price-sensitive users who prefer free content. *Test:* Track Rewarded Video Watch Rate vs. Churn. High watch rates with low churn validate this segment.
3. **The "Whale/High-Value IAP User":** Smaller segment with higher disposable income. *Test:* Track IAP Conversion Rate and Average Revenue Per Paying User (ARPPU).

## 3. Campaign Execution Plan (6 Weeks)
*This plan allocates the $25,000 budget across three phases to maximize learning and minimize waste.*

### Phase 1: Weeks 1–2 (Launch & Baseline)
* **Goal:** Establish internal baselines for Cost Per Install (CPI), Retention, and Lifetime Value (LTV).
* **Budget Allocation:** 50% ($12,500) to establish initial data.
* **Channels:** Paid User Acquisition (UA) in US, UK, and Canada.
* **Creative Concepts:**
    *   **Concept 1: "The Fair Play Promise" (Video):** 15s/30s gameplay clips with overlay text: "No Pay-to-Win. Just Play." [Campaign Systems Designer].
    *   **Concept 2: "Fairness Explained" (Static/Carousel):** 3-card carousel explaining the Ad vs. IAP choice [Campaign Systems Designer].
* **Targeting:** Broad interest targeting (Puzzle, Match-3).

### Phase 2: Weeks 3–4 (Optimization & Learning)
* **Goal:** Validate creative efficacy and regional performance.
* **Actions:**
    *   **A/B Test 1 (Creative):** Compare Video vs. Static CPI. If Video CPI is >10% higher than Static CPI, pause video ads and iterate creative [Measurement & Learning Strategist].
    *   **Organic Social:** Launch "Behind the Blocks" Dev Diary videos on TikTok/Reels to build community and gather qualitative feedback on "fairness" perception [Campaign Systems Designer].
    *   **Regional Shift:** If one region (US, UK, or Canada) shows >20% better CPI or Return on Ad Spend (ROAS), shift 50% of the remaining budget from underperforming regions to the winner [Measurement & Learning Strategist].

### Phase 3: Weeks 5–6 (Decision & Scale Prep)
* **Goal:** Determine Go/No-Go for scaling based on LTV/CPI ratio.
* **Actions:**
    *   **A/B Test 2 (Monetization):** Compare High Ad Frequency/Low IAP Prompt vs. Low Ad Frequency/High IAP Prompt [Measurement & Learning Strategist].
    *   **Decision Gate:** If Day 7 LTV > CPI by 20%, proceed to scale. If LTV < CPI, pause scaling and iterate on gameplay or creative [Measurement & Learning Strategist].

## 4. Measurement & Learning Framework
*You cannot manage what you do not measure. Instrument these events before launch.*

### Key Metrics to Track
* **Acquisition:** CPI by Region/Creative.
* **Activation:** Tutorial Completion, First Match-3 Level Completed, First Rewarded Video Watch.
* **Retention:** Day 1, Day 7, Day 30 Active Users.
* **Monetization:** Rewarded Video Frequency, IAP ARPU, LTV (Day 7, Day 30).

### Decision Thresholds
1. **Go/No-Go for Scaling:**
    *   *Condition:* Day 7 LTV > CPI by 20%.
    *   *Action:* Proceed to scale.
    *   *Failure:* LTV < CPI. Pause scaling and iterate [Measurement & Learning Strategist].
2. **Creative Pivot:**
    *   *Condition:* Video CPI > Static CPI by 10%.
    *   *Action:* Pause video ads and iterate creative [Measurement & Learning Strategist].
3. **Regional Shift:**
    *   *Condition:* One region shows >20% better CPI or ROAS.
    *   *Action:* Shift 50% of budget from underperforming regions to the winner [Measurement & Learning Strategist].

## 5. Critical Risks & Mitigations
* **Risk 1: "Another Generic Clone."**
    *   *Mitigation:* Emphasize "Fairness" and "Polished Gameplay" in creative. Differentiate via art style or unique mechanics [Audience & Context Analyst].
* **Risk 2: "Too Many Ads."**
    *   *Mitigation:* A/B test ad frequency caps. Monitor churn correlation closely. If ad load is perceived as excessive, retention will drop sharply [Audience & Context Analyst].
* **Risk 3: "Pay-to-Win."**
    *   *Mitigation:* Clearly communicate the hybrid model (Ad vs. IAP choice) in the first 3 levels via in-app messaging [Campaign Systems Designer].
* **Risk 4: Regulatory Compliance.**
    *   *Mitigation:* Ensure compliance with Apple App Store and Google Play policies, GDPR (UK/Canada), and CCPA (US).

## 6. Next Actions for the Team
1. **Instrumentation:** Ensure all funnel events (Install, Tutorial Completion, First Rewarded Video Watch, etc.) are tracked in the analytics platform before launch.
2. **Creative Prep:** Finalize the "Fair Play Promise" video and "Fairness Explained" carousel assets.
3. **Baseline Setup:** Define internal baselines for CPI and Retention during Week 1. Do not invent industry benchmarks.
4. **Launch:** Begin Paid UA campaigns in US, UK, and Canada with 50% of the budget.
5. **Review:** Conduct a weekly review of CPI, Retention, and LTV data to inform budget shifts and creative pivots.

This plan provides a clear, evidence-based foundation for the soft launch. All claims are either supported by supplied facts or explicitly labeled as hypotheses to be tested within the $25,000 budget over the six-week timeline.
