import {describe,expect,it} from "vitest";
import {createTranslator} from "next-intl";
import {IntlMessageFormat} from "intl-messageformat";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";
import {TOURS,TOUR_IDS} from "../lib/client/tours";

type TourKey = keyof typeof pt.GuidedTours;
const translate = (locale:"en"|"pt-BR") =>
  createTranslator({locale,messages:locale==="en"?en:pt,namespace:"GuidedTours"});

describe("guided tours bilingual translations",()=>{
  it("covers every tour and every original step with matching keys in both locales",()=>{
    expect(Object.keys(pt.GuidedTours).sort()).toEqual(Object.keys(en.GuidedTours).sort());
    for (const id of TOUR_IDS) {
      expect(TOURS[id].steps.length).toBeGreaterThan(0);
      for (const [index,step] of TOURS[id].steps.entries()){
        for(const suffix of ["title","body"] as const){
          const key = (id+"_"+index+"_"+suffix) as TourKey;
          expect(pt.GuidedTours).toHaveProperty(key);
          expect(en.GuidedTours).toHaveProperty(key);
          expect(en.GuidedTours[key]).toBe(step[suffix]);
          expect(pt.GuidedTours[key].trim().length).toBeGreaterThan(4);
        }
      }
    }
    expect(TOUR_IDS.length).toBe(19);
    expect(TOUR_IDS.reduce((sum,id)=>sum+TOURS[id].steps.length,0)).toBe(52);
  });

  it("validates all 108 ICU strings in both languages",()=>{
    for(const key of Object.keys(pt.GuidedTours) as TourKey){
      expect(()=>new IntlMessageFormat(pt.GuidedTours[key],"pt-BR"),key).not.toThrow();
      expect(()=>new IntlMessageFormat(en.GuidedTours[key],"en"),key).not.toThrow();
    }
  });

  it("renders welcome steps fully in Brazilian Portuguese",()=>{
    const t=translate("pt-BR");
    expect(t("welcome_0_title")).toBe("Boas-vindas ao Linki");
    expect(t("welcome_0_body")).toContain("prospecção pelo LinkedIn");
    expect(t("welcome_1_title")).toBe("Seu espaço de trabalho");
    expect(t("welcome_10_title")).toBe("Precisa de ajuda?");
    for(let i=0;i<11;i++){
      expect(t(("welcome_"+i+"_title") as TourKey).length).toBeGreaterThan(4);
      expect(t(("welcome_"+i+"_body") as TourKey).length).toBeGreaterThan(45);
    }
  });

  it("localizes buttons and progress in both languages without breaking driver placeholders",()=>{
    const ptBr=translate("pt-BR"),english=translate("en");
    expect(ptBr("next")).toBe("Próximo");
    expect(ptBr("back")).toBe("Voltar");
    expect(ptBr("done")).toBe("Concluir");
    expect(english("next")).toBe("Next");
    expect(ptBr("progress",{current:"{{current}}",total:"{{total}}"})).toBe("{{current}} de {{total}}");
    expect(english("progress",{current:"{{current}}",total:"{{total}}"})).toBe("{{current}} of {{total}}");
  });

  it("preserves the same index for a step even when previous target is absent",()=>{
    const t=translate("pt-BR");
    const seenAtIndex=TOURS.welcome.steps.map((step,index)=>({
      target:step.target,
      title:t(("welcome_"+index+"_title") as TourKey),
    })).filter((_,index)=>index===0||index===3||index===10);
    expect(seenAtIndex.map(s=>s.title)).toEqual([
      "Boas-vindas ao Linki","Pesquise e navegue","Precisa de ajuda?"
    ]);
  });

  it("covers page-specific tours with Portuguese descriptions",()=>{
    const t=translate("pt-BR");
    expect(t("dashboard_0_title")).toBe("Escolha o que analisar");
    expect(t("campaigns_0_title")).toBe("Todas as campanhas");
    expect(t("signals_1_body")).toContain("detecção");
    expect(t("developers_0_title")).toContain("Integre");
    expect(t("csv_import_0_body")).toContain("arquivo");
  });
});
