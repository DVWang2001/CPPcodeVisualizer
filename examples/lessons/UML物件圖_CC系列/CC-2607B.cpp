// UML 物件圖教案 CC-2607B：分數向量與物件計數（static 計數器改成全域變數）
// （改寫自 CF 題目 CC-2607B：運算子多載、friend、繼承與 static 改成一般成員函式，才能在瀏覽器引擎逐步執行）
#include<iostream>
#include<vector>
using namespace std;
int g_popu=0;   // 原本是 Score 的 static 成員，這裡改成全域變數
class Score{
   double m_x,m_y;
public:
   ~Score(){g_popu--;}
   Score(double x=0,double y=1):m_x(x),m_y(y){g_popu++;}
   void addIn(const Score& b){
      m_x=m_x*b.m_y+b.m_x*m_y;
      m_y=m_y*b.m_y;
   }
   void divInt(int b){m_y*=b;}
   void read(){
      double p,q;char c;
      cin>>p>>c>>q;
      m_x=p;m_y=q;
   }
   void print()const{cout<<m_x<<"/"<<m_y;}
};
class FVec{
   vector<Score> m_vs;
public:
   FVec(int n):m_vs(n){}
   void sumTo(Score& s)const{
      for(int k=0;k<m_vs.size();k++) s.addIn(m_vs[k]);
   }
   void avgTo(Score& a)const{
      sumTo(a);
      a.divInt(m_vs.size());
   }
   void read(){for(int k=0;k<m_vs.size();k++) m_vs[k].read();}
   void print()const{
      Score s;
      sumTo(s);
      cout<<"sum:";s.print();cout<<endl;
      Score a;
      avgTo(a);
      cout<<"avg:";a.print();cout<<endl;
   }
};
int main(){
   {
      int n;cin>>n;
      FVec pts(n);pts.read();
      pts.print();cout<<endl;  //@ @guide uml:pts
      cout<<g_popu<<endl;
   }
   cout<<g_popu<<endl;
   return 0;
}
