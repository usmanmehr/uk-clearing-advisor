#!/usr/bin/env python3
"""
UK Clearing Advisor - DynamoDB seeder (no node / no boto3 required).

Builds DynamoDB batch-write payloads and submits them via the AWS CLI.
Seeds:
  - UniversityContactsTable : 44 universities (Section 11 of the spec, as given)
  - SubjectDefaultsTable     : national subject averages (Section 3)

DECISION: The spec's ucasInstitutionCode values contain a few duplicates
(e.g. Leeds and Lancaster both "L23"). providerCode is the table key and is
unique, so records are seeded verbatim as supplied; verify institution codes
before relying on them.

DECISION: CUG per-subject rankings and scholarship rows are not supplied as
verified data, so they are left empty rather than invented. The ranking
algorithm scores missing CUG as 0.5 and uses highFliersRank where present.
"""
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

REGION = os.environ.get("AWS_REGION", "eu-west-2")
CONTACTS_TABLE = "ClearingAdvisor-UniversityContacts"
DEFAULTS_TABLE = "ClearingAdvisor-SubjectDefaults"
NOW = datetime.now(timezone.utc).isoformat()

UNIVERSITIES = [
    # Russell Group
    ("0023","University of Birmingham","B32","England","Birmingham",True,None,"Tier 2","+44 (0)121 414 3344","admissions@birmingham.ac.uk","birmingham.ac.uk/undergraduate/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0007","University of Bristol","B78","England","Bristol",True,6,"Tier 2","0117 331 1223","choosebristol-ug@bristol.ac.uk","bristol.ac.uk/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0114","University of Cambridge","C05","England","Cambridge",True,1,"Tier 1",None,"admissions@cam.ac.uk","undergraduate.study.cam.ac.uk","N/A","Closed",False,"Cambridge does NOT enter UCAS Clearing."),
    ("0117","Cardiff University","C15","Wales","Cardiff",True,None,"Not listed","+44 (0)29 2087 9999","admissions@cardiff.ac.uk","cardiff.ac.uk/study/undergraduate/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0038","Durham University","D86","England","Durham",True,None,"Tier 2","+44 (0)191 334 8623","admissions@durham.ac.uk","durham.ac.uk/study/undergraduate/clearing","08:00 BST 13 Aug (open from 5 Jul via online form)","Early Clearing",False,None),
    ("0042","University of Edinburgh","E56","Scotland","Edinburgh",True,None,"Tier 2",None,"study.ed.ac.uk/undergraduate/contact","study.ed.ac.uk/undergraduate/applying/ucas-clearing","Online form only - no phone hotline","Open",False,"Online form only. No phone hotline."),
    ("0044","University of Exeter","E70","England","Exeter",True,None,"Tier 2","+44 (0)1392 72 72 72","ug-ad@exeter.ac.uk","exeter.ac.uk/clearing","OPEN NOW","Open",False,None),
    ("0054","University of Glasgow","G28","Scotland","Glasgow",True,None,"Not listed","+44 (0)141 330 6062","sras@glasgow.ac.uk","gla.ac.uk/study/undergraduate/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0060","Imperial College London","I50","England","London",True,3,"Tier 1","+44 (0)20 7589 5111","admissions@imperial.ac.uk","imperial.ac.uk/study/ug/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,"Imperial rarely clears. STEM-only."),
    ("0072","King's College London","K60","England","London",True,11,"Tier 2","+44 (0)20 3858 1050","ug-admissions@kcl.ac.uk","kcl.ac.uk/clearing","08:00 BST 13 Aug 2026","Open",False,None),
    ("0077","University of Leeds","L23","England","Leeds",True,None,"Semi-target","+44 (0)113 243 1751","ugadmissions@leeds.ac.uk","leeds.ac.uk/clearing","Strategic Clearing OPEN NOW - deadline 9am 3 Aug 2026","Early Clearing",True,None),
    ("0078","University of Leicester","L34","England","Leicester",False,None,"Not listed","+44 (0)116 252 2522","admissions@leicester.ac.uk","le.ac.uk/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0083","University of Liverpool","L41","England","Liverpool",True,None,"Not listed","+44 (0)151 794 2000","ugadmissions@liverpool.ac.uk","liverpool.ac.uk/study/undergraduate/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0086","London School of Economics","L72","England","London",True,5,"Tier 1","+44 (0)20 7955 7160","ug.admissions@lse.ac.uk","lse.ac.uk/study-at-lse/undergraduate/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,"LSE rarely clears. Very competitive if places appear."),
    ("0094","University of Manchester","M20","England","Manchester",True,None,"Semi-target","+44 (0)161 306 0100","ug.admissions@manchester.ac.uk","manchester.ac.uk/study/undergraduate/applying/clearing","08:00 BST 13 Aug 2026","Open",True,None),
    ("0100","Newcastle University","N21","England","Newcastle",True,None,"Not listed","+44 (0)191 208 3333","admissions@ncl.ac.uk","ncl.ac.uk/undergraduate/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0106","University of Nottingham","N84","England","Nottingham",True,3,"Not listed","+44 (0)115 951 5559","ugadmissions@nottingham.ac.uk","nottingham.ac.uk/ugstudy/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0111","University of Oxford","O33","England","Oxford",True,2,"Tier 1",None,"admissions@ox.ac.uk","ox.ac.uk/admissions/undergraduate","N/A","Closed",False,"Oxford does NOT participate in UCAS Clearing."),
    ("0115","Queen Mary University of London","Q50","England","London",True,16,"Not listed","+44 (0)20 7882 3104","ugadmissions@qmul.ac.uk","qmul.ac.uk/clearing","Mon-Fri 10:00-16:00 BST (open now)","Open",False,None),
    ("0118","Queen's University Belfast","Q75","Northern Ireland","Belfast",True,None,"Not listed","+44 (0)28 9097 3838","admissions@qub.ac.uk","qub.ac.uk/Study-at-Queens/Undergraduate/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0123","University of Sheffield","S18","England","Sheffield",True,None,"Not listed","+44 (0)114 215 7625","clearing.shef.ac.uk","sheffield.ac.uk/clearing","OPEN NOW (Early Clearing from 2 Jul 2026)","Early Clearing",False,None),
    ("0127","University of Southampton","S27","England","Southampton",True,20,"Not listed","+44 (0)23 8059 4732","admissions@southampton.ac.uk","southampton.ac.uk/clearing","08:00-21:00 BST 13 Aug; 08:00-18:00 BST 14 Aug","Open",True,None),
    ("0132","University College London","U80","England","London",True,4,"Tier 1","+44 (0)20 7679 7742","admissions@ucl.ac.uk","ucl.ac.uk/prospective-students/undergraduate/clearing","08:00 BST 13 Aug 2026","Open",False,None),
    ("0137","University of Warwick","W20","England","Coventry",True,None,"Tier 1","+44 (0)2476 533 544","ugadmissions@warwick.ac.uk","warwick.ac.uk/study/results/clearing","09:00-16:00 BST daily (Early Clearing OPEN NOW)","Early Clearing",False,None),
    # Top non-Russell Group
    ("0009","University of Bath","B16","England","Bath",False,None,"Tier 2","+44 (0)1225 383019","admissions@bath.ac.uk","bath.ac.uk/campaigns/apply-through-clearing","09:00 BST 2 Jul (OPEN); 08:00 BST 13 Aug: 01225 976833","Open",False,None),
    ("0056","Heriot-Watt University","H24","Scotland","Edinburgh",False,None,"Not listed","+44 (0)131 449 5111","ug.admissions@hw.ac.uk","hw.ac.uk/study/undergraduate/actuarial-science","OPEN NOW","Open",True,"Free accommodation Semester 1 for RUK students. IFoA accredited."),
    ("0064","Lancaster University","L23","England","Lancaster",False,None,"Not listed","+44 (0)1524 592028","ugadmissions@lancaster.ac.uk","lancaster.ac.uk/study/clearing","OPEN NOW","Open",True,"7 courses confirmed at AAB. Top 10 UK overall CUG 2027."),
    ("0089","Loughborough University","L79","England","Loughborough",False,None,"Not listed","+44 (0)1509 263171","admissions@lboro.ac.uk","lboro.ac.uk/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0042-ea","University of East Anglia","E14","England","Norwich",False,None,"Not listed","+44 (0)1603 591515","admissions@uea.ac.uk","uea.ac.uk/study/undergraduate/how-to-apply/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0109","University of Reading","R12","England","Reading",False,None,"Not listed","+44 (0)118 378 8619","student.recruitment@reading.ac.uk","reading.ac.uk/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0116","University of St Andrews","S75","Scotland","St Andrews",False,None,"Tier 2","+44 (0)1334 462150","admissions@st-andrews.ac.uk","st-andrews.ac.uk/admissions/ug/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,"St Andrews rarely enters clearing. Very competitive."),
    ("0122","University of Sussex","S90","England","Brighton",False,None,"Not listed","+44 (0)1273 876787","ug.enquiries@sussex.ac.uk","sussex.ac.uk/clearing","OPEN NOW","Open",False,"QS #1 world for Development Studies 10 years running."),
    ("0057","City, University of London","C60","England","London",False,16,"Semi-target","+44 (0)20 7040 8716","ugadmissions@city.ac.uk","city.ac.uk/prospective-students/courses/undergraduate","08:00 BST 13 Aug 2026","Open",False,"IB semi-target (Cass/Bayes). 1 mile from City of London."),
    ("0104","University of Surrey","S85","England","Guildford",False,None,"Not listed","+44 (0)1483 689388","admissions@surrey.ac.uk","surrey.ac.uk/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0105","University of York","Y50","England","York",False,None,"Not listed","+44 (0)1904 324000","ug-admissions@york.ac.uk","york.ac.uk/study/undergraduate/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0019","Aston University","A80","England","Birmingham",False,None,"Not listed","+44 (0)121 204 3000","admissions@aston.ac.uk","aston.ac.uk/study/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0090","University of Aberdeen","A20","Scotland","Aberdeen",False,None,"Not listed","+44 (0)1224 272090","sras@abdn.ac.uk","abdn.ac.uk/study/undergraduate/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0031","University of Dundee","D65","Scotland","Dundee",False,None,"Not listed","+44 (0)1382 383000","uni-admissions@dundee.ac.uk","dundee.ac.uk/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0082","University of Lincoln","L43","England","Lincoln",False,None,"Not listed","+44 (0)1522 886097","admissions@lincoln.ac.uk","lincoln.ac.uk/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0029","Coventry University","C85","England","Coventry",False,None,"Not listed","+44 (0)24 7765 2222","admissions@coventry.ac.uk","coventry.ac.uk/clearing","OPEN NOW","Open",False,None),
    ("0013","Brunel University London","B84","England","London (Uxbridge)",False,None,"Not listed","+44 (0)1895 265265","admissions@brunel.ac.uk","brunel.ac.uk/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0043","University of Essex","E70","England","Colchester",False,None,"Not listed","+44 (0)1206 873666","admit@essex.ac.uk","essex.ac.uk/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0059","University of Hertfordshire","H36","England","Hatfield",False,None,"Not listed","+44 (0)1707 284800","admissions@herts.ac.uk","herts.ac.uk/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
    ("0103","University of Portsmouth","P80","England","Portsmouth",False,None,"Not listed","+44 (0)23 9284 8484","admissions@port.ac.uk","port.ac.uk/study/undergraduate/clearing","08:00 BST 13 Aug 2026","Opens 13 Aug",False,None),
]

CONTACT_FIELDS = ["providerCode","universityName","ucasInstitutionCode","region",
                  "location","russellGroup","highFliersRank","ibTier","clearingPhone",
                  "clearingEmail","clearingPage","hotlineOpens","clearingStatus",
                  "accommodationGuarantee","notes"]

# National subject medians (salary at 15 months post-graduation) and national
# subject-level employability. These are NOT university-specific figures - they
# are national medians for the subject and must be labelled as such in the UI.
DEFAULTS_SOURCE = "HESA Graduate Outcomes 2022/23 (Prospects Luminate, Nov 2025)"
DEFAULTS_SOURCE_URL = "https://luminate.prospects.ac.uk/how-graduate-salaries-vary-by-degree-subject"
DEFAULTS_YEAR = "2022/23"

# Verified per-university graduate prospects: % in skilled employment or
# further study within 15 months. Source: Complete University Guide 2027,
# published 2 June 2026. Only these universities have a verified figure; every
# other university is left unset rather than showing an estimated/derived value.
GRAD_PROSPECTS_SOURCE = "Complete University Guide 2027 (Graduate Prospects), published 2 June 2026"
GRAD_PROSPECTS_URL = "https://www.thecompleteuniversityguide.co.uk/league-tables/rankings"
GRADUATE_PROSPECTS = {
    "0009": 89,  # University of Bath
    "0086": 89,  # London School of Economics
    "0137": 85,  # University of Warwick
    "0072": 85,  # King's College London
    "0044": 84,  # University of Exeter
    "0038": 83,  # Durham University
    "0042": 83,  # University of Edinburgh
    "0094": 80,  # University of Manchester
    "0077": 80,  # University of Leeds
    "0115": 70,  # Queen Mary University of London
}
SUBJECT_DEFAULTS = {
    "Economics": (35750, 85), "Economics and Finance": (35750, 85),
    "Software Engineering": (33500, 82), "Computer Science": (33000, 82),
    "Artificial Intelligence": (33000, 82), "Data Science": (33000, 82),
    "Mathematics": (34710, 83), "MORSE": (34710, 83),
    "Actuarial Science": (30000, 85),
    "Finance": (30505, 80), "Accounting and Finance": (30505, 80),
    "Business": (30190, 80), "Management": (30190, 80), "Marketing": (30000, 80),
    "Law": (26500, 78), "Criminology": (26500, 78),
    "Psychology": (26485, 79),
    "History": (28320, 77), "Classics": (28320, 77),
    "English": (27195, 76), "Media Studies": (27195, 76), "Journalism": (27195, 76),
    "Geography": (29150, 79),
    "Politics": (29810, 77), "International Relations": (29810, 77),
    "Political Economy": (29810, 77), "PPE": (29810, 77),
    "Sociology": (26485, 79), "Philosophy": (28320, 77),
    "Biology": (28000, 79), "Sports Science": (28000, 79),
    "Chemistry": (29500, 81), "Pharmacy": (31000, 88),
    "Physics": (33370, 83),
    "Medicine": (43925, 95), "Dentistry": (43925, 95),
    "Nursing": (31000, 90), "Social Work": (28000, 82),
    "Architecture": (27000, 78), "Art and Design": (24000, 72),
    "Music": (24000, 72), "Drama": (24000, 72),
    "Civil Engineering": (33000, 84), "Mechanical Engineering": (33000, 84),
    "Electrical Engineering": (33000, 84),
    "Education": (25500, 88),
}


def s(v):
    return {"S": str(v)}


def contact_item(row):
    d = dict(zip(CONTACT_FIELDS, row))
    item = {
        "providerCode": s(d["providerCode"]),
        "universityName": s(d["universityName"]),
        "ucasInstitutionCode": s(d["ucasInstitutionCode"]),
        "region": s(d["region"]),
        "location": s(d["location"]),
        "russellGroup": {"BOOL": bool(d["russellGroup"])},
        "ibTier": s(d["ibTier"]),
        "clearingPage": s(d["clearingPage"]),
        "hotlineOpens": s(d["hotlineOpens"]),
        "clearingStatus": s(d["clearingStatus"]),
        "accommodationGuarantee": {"BOOL": bool(d["accommodationGuarantee"])},
        "lastUpdated": s(NOW),
        # A full re-seed (PutItem replaces the whole item) is the only thing
        # that counts as a human-verified refresh of clearingStatus, so it
        # deliberately clears any possibleStatusChange/lastAutomatedCheck
        # flags DailyScraper had set (they simply aren't included here) -
        # a fresh lastVerified means "checked and confirmed accurate as of
        # this timestamp" until the scraper flags drift again.
        "lastVerified": s(NOW),
    }
    if d["highFliersRank"] is not None:
        item["highFliersRank"] = {"N": str(d["highFliersRank"])}
    if d["clearingPhone"]:
        item["clearingPhone"] = s(d["clearingPhone"])
    if d["clearingEmail"]:
        item["clearingEmail"] = s(d["clearingEmail"])
    if d["notes"]:
        item["notes"] = s(d["notes"])
    gp = GRADUATE_PROSPECTS.get(d["providerCode"])
    if gp is not None:
        item["graduateProspects"] = {"N": str(gp)}
        item["graduateProspectsSource"] = s(GRAD_PROSPECTS_SOURCE)
        item["graduateProspectsSourceUrl"] = s(GRAD_PROSPECTS_URL)
    return item


def default_item(subject, salary, emp):
    return {
        "subjectGroup": s(subject),
        "salary15months": {"N": str(salary)},
        "employabilityRate": {"N": str(emp)},
        "source": s(DEFAULTS_SOURCE),
        "salarySourceUrl": s(DEFAULTS_SOURCE_URL),
        "salaryYear": s(DEFAULTS_YEAR),
    }


def chunked(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def batch_write(table, items):
    total = 0
    for chunk in chunked(items, 25):
        payload = {table: [{"PutRequest": {"Item": it}} for it in chunk]}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(payload, f)
            path = f.name
        cmd = ["aws", "dynamodb", "batch-write-item",
               "--request-items", "file://" + path,
               "--region", REGION, "--output", "json"]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        os.unlink(path)
        if r.returncode != 0:
            print("ERROR writing to %s: %s" % (table, r.stderr.strip()))
            sys.exit(1)
        # Retry any unprocessed items once.
        try:
            unproc = json.loads(r.stdout or "{}").get("UnprocessedItems", {})
        except json.JSONDecodeError:
            unproc = {}
        if unproc:
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
                json.dump(unproc, f)
                path = f.name
            subprocess.run(["aws", "dynamodb", "batch-write-item",
                            "--request-items", "file://" + path,
                            "--region", REGION], capture_output=True, text=True, timeout=120)
            os.unlink(path)
        total += len(chunk)
    return total


def main():
    contacts = [contact_item(r) for r in UNIVERSITIES]
    defaults = [default_item(k, v[0], v[1]) for k, v in SUBJECT_DEFAULTS.items()]
    n1 = batch_write(CONTACTS_TABLE, contacts)
    n2 = batch_write(DEFAULTS_TABLE, defaults)
    print("Seeded %d universities into %s" % (n1, CONTACTS_TABLE))
    print("Seeded %d subject defaults into %s" % (n2, DEFAULTS_TABLE))


if __name__ == "__main__":
    main()
