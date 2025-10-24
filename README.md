# 🧠 Skill Mapping & Diagnostic System – Vertex AI & Gemini API

## 🎯 Overview  

This project focused on building an **AI-assisted skill mapping and diagnostic system** for corporate clients aiming to better understand and measure their workforce capabilities.  

The solution combines **Vertex AI**, **semantic embeddings**, and **Bloom’s taxonomy** to automatically enhance skill definitions, map employee roles, and generate self-assessment surveys for large-scale evaluation.  

The system bridges **HR domain knowledge** with **machine learning and NLP techniques**, creating a scalable pipeline for workforce analytics and skill-based learning strategies.  

---

## ⚙️ Project Workflow  

### **1️⃣ Skill Definition Enhancement**
- Clients upload or input their list of organizational skills.  
- The system calls **Vertex AI (Gemini API)** to:
  - Refine and standardize skill definitions.  
  - Generate **performance levels based on Bloom’s taxonomy** (4-tier scale).  
- The enhanced definitions are presented back to the client for validation.  

🧰 *Tools:* Vertex AI · Gemini API (Text Generation) · Python · YAML Config  

---

### **2️⃣ Embedding Generation & Validation**
- Once validated, the enhanced skills are converted into **semantic embeddings** for similarity analysis.  
- Each skill and performance level is embedded using **Gemini’s text embedding API**.  
- Clients can approve or modify final versions prior to comparison.  

🧰 *Tools:* Python · Gemini API (Embeddings) · Numpy · Pandas  

---

### **3️⃣ Cross-Skill Matching & Suggestion**
- The system compares **client embeddings** with the company’s internal skill catalog embeddings (by skill and Bloom level).  
- Using **cosine similarity**, it identifies related skills and recommends them for each role or employee.  
- Suggests **expected performance levels** based on semantic and contextual alignment.  

🧠 *Key Concept:* Embedding-based skill matching improves alignment between corporate learning objectives and individual competencies.  

🧰 *Tools:* Python · Numpy · Scikit-learn · Gemini API  

---

### **4️⃣ Employee Skill Assignment**
- Clients can upload **employee data via CSV or Excel input**, including job titles, tasks, and development plans.  
- The system assigns suggested skills to each collaborator automatically, allowing the client to review and adjust assignments.  
- This ensures alignment between **roles, responsibilities, and expected skill performance levels**.  

🧰 *Tools:* Python · Pandas · Excel Integration  

---

### **5️⃣ Self-Assessment Survey Generation**
- Based on the finalized skill-role mapping, the system automatically creates **Likert-style self-assessment surveys** per employee.  
- Questions are generated dynamically via **Gemini API (Text Generation)** using the improved skill definitions and Bloom levels.  
- Surveys are then distributed for self-evaluation, forming the foundation for analytics and upskilling initiatives.  

🧰 *Tools:* Gemini API · Python · YAML Template · Excel  

---

## 📊 Results & Impact  

- Created a scalable pipeline to **standardize and map skills across entire organizations**.  
- Reduced manual skill curation and survey creation effort by **>75%**.  
- Enabled **data-driven skill diagnostics**, improving workforce development alignment.  
- Helped establish a consistent **taxonomy of competencies** across client organizations.  

---

## 🧰 Tech Stack  

| Category | Tools & Technologies |
|-----------|---------------------|
| Programming | Python (pandas, numpy, scikit-learn) |
| AI & NLP | Vertex AI · Gemini API (Text Generation, Text Embeddings) |
| Similarity Analysis | Cosine Similarity · Semantic Embeddings |
| Data Handling | CSV Upload · Excel Integration · YAML Config |
| Survey Automation | Gemini API · Likert Generation Templates |
