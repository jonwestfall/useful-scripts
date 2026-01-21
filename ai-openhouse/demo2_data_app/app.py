import streamlit as st
import pandas as pd
import numpy as np

st.set_page_config(page_title="Demo 2: Data to Insight (Local)", layout="wide")
st.title("Demo 2: From Data to Insight (Local)")
st.caption("Upload a CSV and explore patterns locally. No data leaves this computer.")

# -----------------------------
# Helpers
# -----------------------------
def safe_read_csv(uploaded_file) -> pd.DataFrame:
    """Attempt to read CSV robustly with a couple fallbacks."""
    try:
        return pd.read_csv(uploaded_file)
    except UnicodeDecodeError:
        # Common fallback encodings in higher-ed exports
        uploaded_file.seek(0)
        return pd.read_csv(uploaded_file, encoding="latin-1")
    except Exception as e:
        raise RuntimeError(f"Could not read CSV: {e}")

def infer_column_roles(df: pd.DataFrame):
    numeric_cols = df.select_dtypes(include=["number"]).columns.tolist()
    non_numeric_cols = [c for c in df.columns if c not in numeric_cols]

    # Try to identify "likely categorical" among numeric (e.g., 0/1, 1-5)
    likely_cat_numeric = []
    for c in numeric_cols:
        nunique = df[c].nunique(dropna=True)
        if 2 <= nunique <= 12:
            likely_cat_numeric.append(c)

    return numeric_cols, non_numeric_cols, likely_cat_numeric

def top_correlations(df: pd.DataFrame, numeric_cols: list[str], top_n: int = 10):
    if len(numeric_cols) < 2:
        return pd.DataFrame(columns=["Variable A", "Variable B", "Abs Correlation"])

    corr = df[numeric_cols].corr(numeric_only=True).abs()
    # Take upper triangle (no self-correlations)
    upper = corr.where(np.triu(np.ones(corr.shape), k=1).astype(bool))
    pairs = (
        upper.stack()
        .sort_values(ascending=False)
        .head(top_n)
        .reset_index()
        .rename(columns={"level_0": "Variable A", "level_1": "Variable B", 0: "Abs Correlation"})
    )
    return pairs

def distribution_flags(series: pd.Series) -> list[str]:
    flags = []
    s = series.dropna()
    if len(s) < 3:
        return flags

    # Simple skewness warning
    try:
        skew = float(s.skew())
        if abs(skew) >= 1.0:
            flags.append(f"Skewed distribution (skew ≈ {skew:.2f})")
    except Exception:
        pass

    # Outlier-ish flag: large max/min relative to IQR
    try:
        q1, q3 = s.quantile(0.25), s.quantile(0.75)
        iqr = q3 - q1
        if iqr > 0:
            lower = q1 - 3 * iqr
            upper = q3 + 3 * iqr
            outliers = ((s < lower) | (s > upper)).mean()
            if outliers >= 0.02:
                flags.append(f"Notable outliers (≈ {outliers*100:.1f}% beyond 3×IQR)")
    except Exception:
        pass

    return flags

def make_plain_language_summary(df: pd.DataFrame, numeric_cols: list[str], non_numeric_cols: list[str]) -> str:
    n_rows, n_cols = df.shape
    overall_missing = df.isna().mean().mean() * 100

    parts = []
    parts.append(f"This dataset contains **{n_rows:,} rows** and **{n_cols} columns**.")
    parts.append(f"Overall missingness is about **{overall_missing:.1f}%** (averaged across all cells).")

    if numeric_cols:
        parts.append(f"It includes **{len(numeric_cols)} numeric** variable(s) and **{len(non_numeric_cols)} non-numeric** variable(s).")
        # Call out high-missing numeric columns
        high_missing = df[numeric_cols].isna().mean().sort_values(ascending=False)
        if len(high_missing) > 0 and high_missing.iloc[0] >= 0.30:
            worst = high_missing.head(3)
            worst_str = ", ".join([f"{idx} ({val*100:.0f}%)" for idx, val in worst.items()])
            parts.append(f"Some numeric variables have substantial missing data: {worst_str}.")
    else:
        parts.append("It contains **no numeric columns** (or they were not detected as numeric).")

    return " ".join(parts)

def caution_flags(df: pd.DataFrame, numeric_cols: list[str]) -> list[str]:
    flags = []
    n_rows = df.shape[0]
    if n_rows < 50:
        flags.append("Small sample size (< 50 rows). Patterns may be unstable.")

    # Overall missingness
    overall_missing = df.isna().mean().mean()
    if overall_missing >= 0.10:
        flags.append(f"Missing data is non-trivial (overall ≈ {overall_missing*100:.1f}%).")

    # Columns with very high missingness
    high_missing_cols = df.columns[df.isna().mean() >= 0.30].tolist()
    if high_missing_cols:
        flags.append("Some columns have ≥ 30% missing values: " + ", ".join(high_missing_cols[:8]) + ("…" if len(high_missing_cols) > 8 else ""))

    # Very low variance numeric columns
    if numeric_cols:
        low_var = []
        for c in numeric_cols:
            s = df[c].dropna()
            if len(s) >= 3 and float(s.std()) == 0.0:
                low_var.append(c)
        if low_var:
            flags.append("Some numeric columns have zero variance (all values identical): " + ", ".join(low_var[:8]) + ("…" if len(low_var) > 8 else ""))

    return flags

# -----------------------------
# Upload
# -----------------------------
uploaded = st.file_uploader("Upload a CSV", type=["csv"])

if not uploaded:
    st.info("Try a sample CSV from data_samples/ (mount or upload).")
    st.markdown(
        """
**What you can do here (quick tour):**
- **Dataset Overview**: missingness, column types, likely roles  
- **Potentially Interesting Patterns**: strong correlations, odd distributions  
- **Interactive Visualizations**: choose variables and explore  
- **Plain-language Summary + Cautions**: a readable narrative and red flags
"""
    )
    st.stop()

# Read data
try:
    df = safe_read_csv(uploaded)
except Exception as e:
    st.error(str(e))
    st.stop()

# Basic cleanup: avoid exploding on column name weirdness
df.columns = [str(c) for c in df.columns]

numeric_cols, non_numeric_cols, likely_cat_numeric = infer_column_roles(df)

# -----------------------------
# Top preview
# -----------------------------
st.subheader("Preview")
st.dataframe(df.head(50), use_container_width=True)

# -----------------------------
# 1) Dataset Overview
# -----------------------------
st.subheader("1) Dataset Overview")

c1, c2, c3, c4 = st.columns(4)
c1.metric("Rows", f"{df.shape[0]:,}")
c2.metric("Columns", f"{df.shape[1]:,}")
c3.metric("Numeric cols", f"{len(numeric_cols):,}")
c4.metric("Avg missing (%)", f"{df.isna().mean().mean()*100:.1f}")

with st.expander("Column types and missingness", expanded=True):
    overview = pd.DataFrame({
        "Column": df.columns,
        "Detected type": [str(df[c].dtype) for c in df.columns],
        "Missing (%)": (df.isna().mean() * 100).round(1).values,
        "Unique values": [df[c].nunique(dropna=True) for c in df.columns],
    }).sort_values(by="Missing (%)", ascending=False)
    st.dataframe(overview, use_container_width=True)

    if likely_cat_numeric:
        st.caption(
            "Note: Some numeric columns look categorical (few unique values). "
            f"Examples: {', '.join(likely_cat_numeric[:8])}{'…' if len(likely_cat_numeric)>8 else ''}"
        )

# -----------------------------
# 2) Potentially Interesting Patterns
# -----------------------------
st.subheader("2) Potentially Interesting Patterns")

colA, colB = st.columns([2, 1])

with colA:
    if len(numeric_cols) >= 2:
        corr_pairs = top_correlations(df, numeric_cols, top_n=10)
        if corr_pairs.empty:
            st.write("No correlations available (insufficient numeric data).")
        else:
            st.write("**Strongest numeric correlations (absolute value):**")
            st.dataframe(corr_pairs, use_container_width=True)
            st.caption("Tip: Correlation suggests association, not causation.")
    else:
        st.write("Add at least two numeric columns to see correlation patterns.")

with colB:
    if numeric_cols:
        candidate = st.selectbox("Check a numeric column for distribution flags", numeric_cols)
        flags = distribution_flags(df[candidate])
        if flags:
            st.write("**Flags:**")
            for f in flags:
                st.warning(f)
        else:
            st.success("No obvious distribution flags detected (simple heuristics).")
    else:
        st.info("No numeric columns detected to run distribution checks.")

# -----------------------------
# 3) Interactive Visualization
# -----------------------------
st.subheader("3) Explore Relationships")

if numeric_cols:
    viz_type = st.radio("Visualization type", ["Scatter", "Histogram", "Box (by group)"], horizontal=True)

    if viz_type == "Scatter":
        v1, v2, v3 = st.columns(3)
        x = v1.selectbox("X-axis (numeric)", numeric_cols, index=0)
        y = v2.selectbox("Y-axis (numeric)", numeric_cols, index=min(1, len(numeric_cols)-1))
        group_options = ["None"] + non_numeric_cols + likely_cat_numeric
        group = v3.selectbox("Color/group by (optional)", group_options)

        plot_df = df[[x, y] + ([] if group == "None" else [group])].dropna()
        if plot_df.empty:
            st.warning("No complete rows available for the selected variables.")
        else:
            if group == "None":
                st.scatter_chart(plot_df, x=x, y=y)
            else:
                # Streamlit scatter_chart supports color= on recent versions; if it errors, fall back to no color.
                try:
                    st.scatter_chart(plot_df, x=x, y=y, color=group)
                except TypeError:
                    st.scatter_chart(plot_df, x=x, y=y)
                    st.caption("Color grouping not available in this Streamlit build; showing ungrouped scatter.")

    elif viz_type == "Histogram":
        v1, v2 = st.columns([2, 1])
        col = v1.selectbox("Numeric column", numeric_cols)
        bins = v2.slider("Bins", min_value=5, max_value=60, value=20, step=5)

        s = df[col].dropna()
        if s.empty:
            st.warning("No data available for that column.")
        else:
            hist = pd.cut(s, bins=bins).value_counts().sort_index()
            st.bar_chart(hist)

    else:  # Box (by group)
        if non_numeric_cols or likely_cat_numeric:
            v1, v2 = st.columns(2)
            y = v1.selectbox("Numeric outcome", numeric_cols)
            group_options = non_numeric_cols + likely_cat_numeric
            g = v2.selectbox("Group by", group_options)

            # For a simple box-like view without extra libs, show per-group summary stats
            grp = df[[y, g]].dropna().groupby(g)[y]
            summary = grp.agg(["count", "mean", "median", "std", "min", "max"]).reset_index()
            summary = summary.sort_values("count", ascending=False)

            st.write("**Per-group summary (a boxplot-style view via stats):**")
            st.dataframe(summary, use_container_width=True)
            st.caption("Tip: A true boxplot can be added later (e.g., via Plotly).")
        else:
            st.info("No categorical/grouping columns detected.")
else:
    st.info("No numeric columns detected, so interactive numeric visualizations are limited.")

# -----------------------------
# 4) Plain-language summary + cautions
# -----------------------------
st.subheader("4) Plain-Language Summary + Cautions")

summary_text = make_plain_language_summary(df, numeric_cols, non_numeric_cols)
st.markdown(summary_text)

flags = caution_flags(df, numeric_cols)
if flags:
    st.write("**Caution flags (automatic checks):**")
    for f in flags:
        st.warning(f)
else:
    st.success("No major caution flags detected by these simple checks.")

# -----------------------------
# "This demo could have also done..."
# -----------------------------
st.divider()
st.subheader("This demo could have also done… (not shown today)")

st.markdown(
    """
To keep this open-house version fast and broadly applicable, we **didn't** enable some features that are possible locally:

- **Predictive modeling**: choose an outcome variable and estimate which factors best predict it (with interpretability).
- **Automatic “interesting findings” narratives**: generate a plain-English mini-report of key takeaways and questions to explore.
- **Outlier / anomaly detection**: flag unusual cases for follow-up or data quality checks.
- **Fairness / subgroup checks**: compare outcomes across groups when appropriate (and highlight imbalance).
- **Report export**: one-click PDF/HTML summary for assessment, accreditation, or research notes.
- **Local AI assistant on top of the dataset**: ask questions in natural language (e.g., “What changed most from pre to post?”).

If any of those would be useful for your teaching, research, or service work, please tell us — those are great candidates for follow-up workshops.
"""
)
